# Returning password sign-in — CD-221 bounded server contract

This stack adds returning-password access, atomic emailed-proof issuance/consumption,
committed attempt feedback and the legacy staging code view on staging `f8e1684f`.
The server-first layer excludes the attempt-feedback delta; this dependent layer
adds it with the client and its dedicated browser gate. It does not activate the
separate v2.3 presentation or implement the rest of the pack.
Authoritative sources: [CD-221](https://app.notion.com/p/419572f3e39b810e915ec14ae3bd408b),
BUILD-SIGN-IN v2.3 (15 November), SIGNUP-LOGIC through §16, and the original
prototype. Appearance/copy follows the prototype; data/security follows BUILD
and LOGIC. Pending product questions stay in the existing Notion discussion.

## API and compatibility

| Request | Result |
| --- | --- |
| `POST /api/auth/login/start {identifier}` | `200 {next:"password"}` for known and unknown identifiers. A confirmed active CurrencyDesk ID may additionally return `shopName` (the tenant operating name). An email never does. No personal name, initials, email, session or proof is returned. |
| `POST /api/auth/login/password {identifier,password}` | Wrong, unknown, inactive or unverified ownership: generic `401 invalid_credentials`. At the shared limit: `429 too_many_attempts` with pack copy and `retryAfter` seconds. |
| Valid password, email identity | `200` with `next:"code"`, `needsCode:true`, masked address and permitted post-password user data. Only a random login-proof cookie is issued. The existing `/api/auth/login/verify {staffId,code}` must consume the real generated code before issuing a session. |
| Valid password, established legacy non-email staff identity | Existing password-only policy is retained: `next:"authenticated"`, `needsCode:false` and a real session. This is compatibility, not a new no-email signup policy. |
| Dependency or delivery failure | Safe `503`, no authentication response. A failed delivery deletes its proof. New password requests mark email sensitive and never use staging on-screen code delivery or unconfigured-provider simulation. Existing mail transport has a 10-second timeout. |

New bodies are strict objects: trimmed identifier length 1–254, password length
1–512; extra fields are rejected. Malformed/oversized/unsupported request
bodies retain safe client errors. Code verification also accepts identifiers
up to 254 characters, matching valid signup emails. Existing `/login {staffId,password,tenantId?}`
and password-bearing `/login/start` retain their contract. `/login` still refuses
an email identity with `403 code_required`; it cannot bypass the code step.
Both old doors resolve the same returning identities and share counters.
The password-change gate explicitly permits the new login route, just as it
permits the other login routes. Protected routes remain gated.

Sessions remain opaque hashed tokens with a **12-hour absolute expiry**.
This slice adds no device trust, enrolment resume, passkey assertion, OIDC,
PIN, recovery or step-up. Existing code TTL/attempt policy is reused; complete
v2.3 code/resend behavior belongs to its later slice.

## Emailed-proof consumption (bounded follow-on)

`/api/auth/login/verify` serializes on the hashed proof row with `FOR UPDATE`
inside a Drizzle transaction on both native PostgreSQL and PGlite. The lock
covers validation, wrong-attempt accounting and successful session creation.
A wrong guess uses `attempts = attempts + 1`, guarded by attempts below five
and `expires_at > clock_timestamp()`. A correct guess must obtain a returned
row from the same guarded deletion. A stale read never authorizes a session.
The clock predicate is evaluated at the write, including after identity or
tenant lock waits; transaction-start `now()` would incorrectly extend validity.
The initial locked read also refuses expired or already-exhausted proofs.
The write's attempt limit is defence in depth as well as the locked-read check:
a direct helper regression verifies that an exhausted row cannot be incremented
or consumed even without that read. Removing the write guard fails that test.

Verification sets transaction-local `lock_timeout` to five seconds before
acquiring locks. Each blocked acquisition then fails through the existing safe
503 handler and rolls back; an eligible proof can be retried. The setting ends
with the transaction. This bounds individual lock waits, not the whole request,
query execution, network delivery or commit acknowledgement. Native regressions
hold proof, staff and tenant table locks beyond the budget, assert no cookie,
session or audit, then release the lock and successfully retry the same proof.
A separate successful verification uses a dedicated PostgreSQL connection, then
checks its backend ID and lock setting after COMMIT. Replacing SET LOCAL with
plain SET fails this test even when it runs alone.

After a committed wrong-attempt update for a password-proven, matching active
identity, guesses one through four return `401 wrong_code`, `remainingAttempts`
of 4, 3, 2 and 1, and `detail`: “That code didn’t match. N tries left.” The last
uses “1 try left.” The count comes from the atomic UPDATE's returned row, not a
read followed by local subtraction. It describes the allowance at that write;
another committed request can spend more before the response arrives. It is
not a reservation for the next request. No remaining count is sent before COMMIT.

The fifth wrong guess records five and deletes the terminal proof in the same
transaction. Its response is immediately `429 too_many_attempts` with “Too many
tries. Sign in again.” and clears the proof cookie after commit. It exposes no
remaining count and offers no sixth usable guess. Expiry returns `410 expired`
and deletes the proof;
subsequent replay is the generic `401`. Once a correct request wins, queued
requests cannot recreate or spend that proof. If it wins before a fifth wrong
attempt, it may complete; if the fifth wrong attempt wins first, it cannot.

The proof's staff ID selects the authoritative staff row. Active staff and
matching submitted identifier are required; staff and tenant rows are held
with share locks through commit, and suspended or missing tenants are refused.
A request's tenant field cannot change the session's shop. An absent cookie
returns the same dummy-comparison refusal without a database identity lookup;
an unknown cookie does not look up staff either. Password/provisioning identity
resolution and the existing no-email policy remain unchanged.
Missing/unknown proof or mismatched identity receives the existing generic
`401 wrong_code` without `remainingAttempts`; malformed and mismatched requests
that did not consume guesses still do not. Suspended desks retain their safe
403. No attempted identity, code, proof token or private exception is added to
response detail or dependency logs.

**Proof deletion, session insertion and `auth.login` audit insertion commit
in one transaction**, including the payload's plan read. No response cookie
is changed before commit. A database/write/session/audit failure rolls back
and returns the existing bounded `503 temporarily_unavailable` contract;
no partial session or consumed proof survives a confirmed rollback. An
unexpired proof may be retried after that rollback. A lost commit acknowledgement
or lost HTTP response can leave delivery uncertain after a successful commit:
the proof stays spent, and a later attempt cannot mint a second session.
Immediate or deferred failure of a wrong-attempt UPDATE or fifth-attempt DELETE
also rolls back the count and preserves the proof. It returns 503 without a
remaining count or cookie mutation, so it never claims a rolled-back consumption.
This is not a resolution of issue #769's session-cookie/body-timeout contract.

Consumption preserves exclusive spending of each issued proof. The bounded
issuance follow-on below additionally serializes replacement per user. Neither
changes signup state, resend quotas, trust, PIN, reset, provider or session
lifetime policy. The complete code/device pack and issue #771 remain outstanding.

`server/tests/login-proof.postgres.test.ts` uses observed native database lock
barriers for duplicate successes, exact wrong-attempt accounting, both mixed
request orders, terminal state changes and expiry during identity waits. It
also checks eight concurrent wrong requests produce only counts 4/3/2/1, exactly
five consumed guesses and one terminal 429; a deferred commit barrier proves
no count leaves while commit is pending. Native and embedded `login2fa` cases
cover the sequential copy, correct-before-exhaustion, malformed/mismatched
requests, immediate/deferred rollback, retry and sanitized dependency logs.
The native suite checks active/suspended authority, database/session/audit
rollback and retry,
plus real HTTP password → generated email code → session → authoritative tenant
and replay. Mail delivery is intercepted in that synthetic test; the code,
proof, hashing, session, audit and API are real. Existing embedded login tests
exercise the same transaction path. Baseline fault controls reproduced an
orphan session after audit failure and proof loss after session-insert failure.

## Atomic proof issuance (bounded follow-on)

`createLoginProof` is the single production issuance boundary, called by the
existing `passwordLogin` after credentials and identity checks. Inside one
transaction it sets `lock_timeout='5s'`, acquires
`pg_advisory_xact_lock(hashtextextended('login-proof:' || userId, 0))`, deletes
that staff user's previous rows and inserts one new proof. Explicit READ COMMITTED
gives DELETE a fresh snapshot after the lock wait, even when a connection has
a REPEATABLE READ default. Call this helper with the root database, never
inside another transaction: its return must mean the proof was committed before
mail delivery. Drizzle ignores isolation options for nested transactions. The
helper checks the actual isolation before any lock or write and refuses an
inherited REPEATABLE READ or SERIALIZABLE snapshot, preserving the old proof.
This guard does not make nested READ COMMITTED a supported delivery boundary;
its outer transaction could still roll back after the helper returns.
The key uses the resolved database staff ID, never a requested tenant or
identifier spelling.
The same SQL runs on native PostgreSQL and PGlite; no migration is required.
Any future issuer must use this helper. Direct table writes are not protected
by a new unique constraint. Existing duplicate rows are removed on replacement.

The advisory lock serializes issuers even with no previous row. It is per
account, not global; a hash collision can cause incidental contention but
cannot allow extra proofs. The issuer then takes proof row locks, without
first taking an exclusive staff/tenant lock. Verification retains its existing
proof → staff SHARE → tenant SHARE order and never needs the issuer lock.
Thus a verifier holding the old proof can finish before replacement, or wait
for replacement and observe the old proof absent after commit. On confirmed
rollback, the waiting verifier can still use the old eligible proof.

Commit is the proof-validity ordering point. A successful replacement makes
the old proof unusable; failure before a confirmed rollback preserves it.
This does not revoke a session already committed by an earlier verification.
Each lock acquisition has the existing five-second budget and dependency
failure uses the existing safe 503. This is not a whole-request deadline.

Email remains outside the transaction. Concurrent HTTP responses and provider
arrival order may differ from database commit order: a late response can carry
an already superseded proof. Single active proof does not promise exactly-once
HTTP or email delivery. Failed mail deletes only its own proof hash, so it
cannot remove a newer replacement. If that failed delivery was the latest
committed replacement, no proof remains: the previously replaced proof is not
restored. This pre-existing behavior is distinct from confirmed database rollback.
Lost COMMIT acknowledgement/response (#769)
remains unresolved; an uncertain outcome does not prove rollback. The existing
120-second send gap and future three resends per fifteen minutes are separate
work. No signup enrolment proof, trust, PIN, recovery, provider or session
duration changes are included.

Acceptance mapping (`server/tests/login-issuance.test.ts`):

| Contract | Evidence |
| --- | --- |
| One usable proof, including initially empty accounts | Two independent PG connections with REPEATABLE READ defaults; trigger gate and observed lock waits; both returned proofs verified |
| Confirmed rollback preserves prior proof | Immediate INSERT and deferred COMMIT trigger failures; safe 503, no mail/cookie, previous proof still verifies; PG and PGlite |
| No global serialization | A second account completes while the first INSERT is held |
| Issuance/verification ordering | Observed proof/tenant waits in both orders, including failed replacement |
| Bounded contention and cleanup | Held proof/advisory locks return 503 before release; retry works; same-connection budget and advisory-lock release checked |
| No provider call under issuance locks | Held synthetic mail permits another password request; late failed mail preserves newer proof |
| Existing real authority and HTTP wiring | `login-proof.postgres.test.ts`: real HTTP password → generated code → session → `/api/tenant`, replay refusal; existing five-attempt/expiry tests retained |

The parent controls fresh independent review and full final-head gates. Focused
checks do not complete the full code/device pack or the separate client 503
presentation integration.

## Identity and ownership

`findReturningStaff` preserves the legacy resolver and raw username spelling
(with its existing case/whitespace comparison), including numeric CD-IDs. It
resolves fully spelled canonical `CD-AAAA-7K42` alphanumeric IDs against the
union of matching `cd_id` and legacy username records. Two distinct staff are
ambiguous and receive no login or shop-name disclosure, regardless of which
password is supplied. No spelling wins. A sole existing legacy username still
works. Staff creation/availability reserves full v2 ID spellings just as it
already reserves numeric IDs. Compact/prefix-free normalization and the final
collision-precedence policy remain pending CTO; fail-closed ambiguity does not
choose that policy. Existing duplicate-email legacy tenant
selection is unchanged; new input does not accept a caller-selected tenant.

For an ID linked to a signup enquiry, returning access requires the active
signup account, verified email, matching enquiry/onboarding/staff tenant,
the exact provisioned owner ID (`tenantId:normalized enquiry email`), matching
staff identity, and a verified password credential. Unverified candidate
credentials and `reserved`, `enrolling`, or `verified` accounts do not authorize
returning login. The credential is evidence of completed enrolment, not the
password source: verification uses the **current staff password hash**, so a
password reset cannot revive the old enrolment copy. `staff_users.email` is a
contact address and is never an authentication alias. Established staff
without an associated signup reservation retain their existing access policy.
Suspended staff/tenants cannot receive a session through the password step.

## Persistent limits and timing

`signin_failures` stores the account bucket (resolved staff ID for every known
alias) and connection bucket from the existing trusted-client-IP resolver.
Both limits are ten in the existing 15-minute window measured from the first
reservation. Wrong attempt ten locks; correct passwords after the limit are
refused. A manager clear removes only the account bucket. The staging ticket
quota remains twenty with a separate bucket. Platform-admin MFA is unchanged.

Atomic SQL upserts reserve attempts before hashing. Concurrent in-flight
attempts conservatively count toward the limit. A successful reservation clears
the account only if its count and exact PostgreSQL window timestamp still
match. It releases its connection increment only if that does not reopen a
window another request locked. PostgreSQL timestamp microseconds are retained
for comparison; a JavaScript millisecond projection cannot clear the row
reliably. A released zero-count connection row is removed only while its exact
window still matches; a concurrent increment/new window cannot be deleted.
This is not a general expired-row retention policy. Restarts do not clear either bucket. No migration is needed.

ID-shaped identifier starts use separate persistent ID and connection buckets.
Only lookups with no disclosed shop name count as misses; repeated confirmed
IDs consume no allowance. Locks are checked before the lookup, so a blocked
connection receives the same 429 for known and unknown IDs without shop data.
Misses reserve the connection first and skip the ID increment when already
over its limit. Concurrent in-flight misses can reach eleven connection
reservations, but the counter saturates there and only ten can add ID counts.
Subsequent blocked requests create no new buckets. These counters survive
restart, expire after 15 minutes and do not consume password guesses. Allowed
identifier starts perform the same minimal staff/tenant query for every
identifier; colliding usernames suppress the shop line and count as misses. Start applies a 150ms response floor
on success, throttle and dependency failure.
Tests compare known/unknown ordinary timing and real PostgreSQL table-lock
delays beyond that floor. The floor is **not proof of constant-time behavior**:
query plans, cache state, scheduling, contention, outages and network behavior
can still vary, especially above it. Confirmed-ID operating-name disclosure is
the explicit pack exception. Password attempts perform one current-cost
Argon2id and one legacy scrypt verification up to the limit, substituting public
dummy hashes as needed. Once atomic reservations are already beyond either
limit, all identities receive 429 before either expensive hash. This equalizes ordinary hashing work, not arbitrary stored hash
parameters or broken dependencies. Slow/failing hash and DB paths fail closed.

Refusals retain `auth.login_failed`/`auth.login_locked` actions with reason
codes and, for a resolved account, a SHA-256 account reference. Raw staff IDs,
attempted email addresses, passwords and codes are absent from audit detail.
Known-account entries preserve the authoritative database actorId for existing
per-person audit views; this may contain a legacy email-shaped staff identity,
but never copies the attempted spelling into detail. Unknown refusals write
only a bounded server-log reason, not a platform audit row, so guessed names
cannot displace real platform events. Dependency logs use a fixed reason,
not database/provider exception text. Successful authentication keeps the
existing actor audit. Counter storage remains the existing private DB schema.

## Verification and open gates

Focused PostgreSQL coverage includes canonical/email/numeric/legacy identity,
active verified ownership, contact-email rejection, wrong/unknown privacy,
real code-to-session exchange, tenant scope, suspension, all three password
doors sharing counters, connection spray, tenth attempt, expiry, restart,
concurrent reservations, late success, current-hash reset behavior and
DB/hash/mail failure. The signup activation journey also exercises returning
login against its actual newly provisioned owner. Synthetic test mail and
billing fixtures perform no external sends or payments.

Independent exact-SHA review and the full final-head workflow contracts remain
with the coordinator. Activation also depends on the separate UI slice and
its input-formatting fix, signup dependency acceptance, and unanswered Q19,
Q20, Q21 and identifier ambiguity. Passing this slice's focused checks is not
whole-pack, CTO, release or live approval.

### Additional activation gates from independent review

The new password endpoint currently preserves established legacy no-email
password-only access. Before activating the complete pack, replace that path
with its required approved-computer plus PIN flow (BUILD §§2/13), while
separately preserving the compatibility needed by existing callers. Q20 still
blocks the first-PIN enrollment policy. This compatibility is not pack acceptance.

Current audit actions remain `auth.login`, `auth.login_failed` and
`auth.login_locked`. Their pack counterparts are `auth.signed_in`, `auth.failed`
and `auth.locked_out`; reconcile those names and required method/reason data
with existing audit consumers before activation. Code/device/recovery event
coverage belongs to the corresponding later slices. Wrong-code feedback does
not add code-failure audit events; that retained gap is outside this bounded fix.

Pre-existing ID-shaped usernames fail closed if they collide with issued IDs.
Before activation, an authorized read-only staging/live count must establish
whether such records exist; no production-data inspection has been performed
here. Coordinate an ID-issuance collision check with the signup owner before
editing `enquiries/cd-id.ts`. Email remains available for an affected verified
owner. This is a compatibility gate, not a claim that existing data is clean.

### Lock UI seam isolation

The real phone lock tests spend the shared loopback connection's ten misses.
Each now snapshots and restores only that connection bucket and its unique
synthetic account bucket in the disposable PostgreSQL database. Existing
counter values and timestamp precision survive; unrelated accounts are never
cleared. Restoration runs after the lock and local-clock assertions, including
on failure. A subsequent real cashier login proves the suite did not leave the
connection locked. The two real-lock cases require SEAM_DATABASE_URL; the full
required CI suite supplies it. Mocked failure-state checks remain independent.
No production limiter or financial assertion is changed.

Further pre-activation limits from review: the limiter compares database window
timestamps with the app clock; a positive app-clock skew near expiry can return
a safe 503 rather than 429. Fix this using a consistent authoritative clock.
When both lookup buckets are locked, the connection-first response can
understate a longer ID wait; it stays independent of the probed ID. Resolve
that user-facing wait behavior alongside the existing expired-row retention
gap. These are recorded findings, not completed fixes.

### Client error presentation at integration

The integrated legacy code screen handles verification 5xx as a temporary
service failure and keeps the displayed staging code available for retry.
The earlier exact-source staging reviews exercised real proof-lock 503 and
successful retry without spending an attempt; final-head gates remain required.
The separate v2.3 presentation is not activated or covered by that legacy check.
This client has no request deadline; the five-second server lock budget is not
evidence of a whole-request deadline or resolution of issue #769.

## Legacy staging code display

The password-bearing `/api/auth/login/start` retains `!pack` and calls
`stagingFixtureOwner` with the resolved `user.staffId` and `user.tenantId`.
A canonical CD-ID can therefore resolve the synthetic owner; the typed alias
is not provenance. CD206 owns that helper: exact staging runtime/raw Host,
exactly one database staging marker, matching owner/slug, test-shop tenant and
exactly one accepted, tenant-bound, server-marked staging enquiry are required.
The older `/api/staging/fresh-shop` fixture alone does not qualify. The newer
password endpoint never returns an on-screen code. Closed gates retain the
existing ordinary delivery path; this change does not rewrite mail transport.

The legacy client separately requires the successful same-origin staging-door
response and a successful, well-formed issuance reply containing a six-digit
string for a synthetic response identity. It keeps the code only in component
memory, labels it "Staging test code", and says it was not emailed. Existing
keypad touch or keyboard activation manually enters it; no code is copied into
the entry state or automatically submitted. Resend clears the old display before
requesting a replacement. Failed/malformed issuance, navigation/identity changes,
terminal verification and completion/unmount invalidate it. An attempt generation
rejects stale UI updates. Pending Back, identity edits and recovery navigation
are disabled and guarded by the synchronous latch, which serializes issue/verify.
A late successful verification or a parsed password-only start reply
(`needsCode === false`) uses the existing server logout and checks `/api/auth/me`
for 401. Code-required issuance and resend do not create sessions and never
trigger this cleanup: boot resume may have adopted an existing session while
they were pending. Cleanup has a ten-second total budget. Both confirmed and
uncertain cleanup explicitly open `/app` so the existing session bootstrap
resolves the visible state, rather than leaving a blank or stale signed-in screen. This is an engineering choice pending CTO
review, not a guarantee against lost responses, page destruction or arbitrary
network/commit delivery. In particular, aborting a timed-out logout does not
prove that it stopped server-side: it can revoke after bootstrap has adopted the
session. That unresolved ordering remains under #769; the fallback is not a
guarantee of settled session state. Independent review of `4ea020ae` also
reproduced Low L-C: an unreadable late password-only success can replace the
HttpOnly cookie while the earlier identity's chooser remains on screen. The
server still enforces the cookie's rights, with no privilege gain observed.
This specific lost-body mismatch is retained under #769 for the reconciliation
contract; it is not fixed or a reason to log out code-only replies. The client
never retries the authentication write. A retryable
verification 5xx keeps the displayed code, clears the entered digits and reports
service trouble; a real five-second proof-lock case then retries the same code
through the keypad. Network failure also retains the display but does not claim
the proof remains usable; a response may have been lost after commit. This does not solve lost cookie
acknowledgements (#769), add a request timeout, or activate the v2.3 client.

`playwright.staging-signin.config.ts` runs the focused real signup/returning seam
and client fault/race cases against a fresh disposable native PostgreSQL database.
The real cases use the staging ticket/application and normal signup endpoints,
then read the code off the rendered screen and prove the resulting session's
tenant. Real-server controls cover pending navigation, late password-only/code
success after unmount, confirmed logout, and visibly resolved sessions when
cleanup is refused or hangs. Tests intercept transport timing, not proof/session
creation. Boot-resume controls also preserve an existing session after a late
code-required initial request and resend, without a React/root-unmount hook.
The resend control seeds only the initial keypad presentation to avoid the
two-minute gap; its held resend, proof issuance and session are real. The initial
request control uses the real server throughout. See DEVELOPMENT for the command. CI runs this config separately after
the ordinary suite on a new disposable database and requires its own completeness
report. The default financial gate is unchanged. Parent owns full final-head
checks and hosted verification.

## Delivery layers and copy check — 16 November 2026

The integrated `11834f2e` full server run found a duplicated resend fallback
string that exceeded the existing dash ratchet. The client now defines that
unchanged sentence once and reuses it; the source and bundle baselines are not
raised. The original failing run is retained, and fresh final-head gates are
required for both delivery layers. The server layer contains 396 changed
handwritten production lines. Client/feedback and protected CI wiring are
reviewed separately against that layer. No financial assertion is weakened.

The stack includes the signup display-only update from staging `f8e1684f`;
its signup sources and generated files remain identical to that staging head.
Both layers require CTO protected-surface review and Linux CI. The hosted
same-shop returning walkthrough remains unproved until deployment. Issues
#769 and #771 and the broader policy, provider and v2.3 activation holds remain.

### Local gate transport dependency

PR791 (`63fb07a6`) precedes the fixture/server/client delivery stack. The dedicated
staging config opts into its exact local HIBP range response fixture; ordinary
local seams use the same dependency automatically. Auth and generated sign-in
code remain identical to reviewed `d742ac18`. This removes an external test
dependency, not the live breach check. New full gates and hosted returning
verification remain required; #769 and #771 are unchanged.
