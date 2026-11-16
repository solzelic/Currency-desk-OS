# Returning password sign-in — CD-221 bounded server contract

This server-first candidate adds returning-password access and atomic emailed-proof
issuance/consumption on staging `f8e1684f` (16 November 2026). Its server logic
comes from the independently reviewed `cd63a7d6` line, with the accepted signup
staging helper callsite. It does not include the later remaining-attempt feedback
or staging code display; those are a dependent delivery slice. It activates no
v2.3 presentation and is not whole-pack or release acceptance.
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

The fifth wrong guess retains the existing `401 wrong_code` response and
records five. The next attempt receives `429 too_many_attempts` and deletes
the terminal proof. Expiry returns `410 expired` and deletes the proof;
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

**Proof deletion, session insertion and `auth.login` audit insertion commit
in one transaction**, including the payload's plan read. No response cookie
is changed before commit. A database/write/session/audit failure rolls back
and returns the existing bounded `503 temporarily_unavailable` contract;
no partial session or consumed proof survives a confirmed rollback. An
unexpired proof may be retried after that rollback. A lost commit acknowledgement
or lost HTTP response can leave delivery uncertain after a successful commit:
the proof stays spent, and a later attempt cannot mint a second session.
This is not a resolution of issue #769's session-cookie/body-timeout contract.

Consumption preserves exclusive spending of each issued proof. The bounded
issuance follow-on below additionally serializes replacement per user. Neither
changes signup state, resend quotas, trust, PIN, reset, provider or session
lifetime policy. The complete code/device pack and issue #771 remain outstanding.

`server/tests/login-proof.postgres.test.ts` uses observed native database lock
barriers for duplicate successes, exact wrong-attempt accounting, both mixed
request orders, terminal state changes and expiry during identity waits. It
checks active/suspended authority, database/session/audit rollback and retry,
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
coverage belongs to the corresponding later slices.

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

The legacy code screen on this server development base maps a detail-less
verification 503 to its wrong-code fallback. A valid proof may still be retried
after contention; that message is inaccurate. The separate presentation branch
handles 5xx distinctly. Integration must drive a real verification 503 and retry
in both presentations, without claiming the server-only checks cover that UI.
This server head has no client request deadline; the five-second lock budget
is not evidence of any client timeout or of a whole-request deadline.

## Server-first staging delivery composition

The password-bearing `/api/auth/login/start` calls `stagingFixtureOwner` with
resolved `user.staffId` and `user.tenantId`, keeping `!pack`. A canonical CD-ID
resolves to the activated owner email; typed aliases are not provenance. The
signup-owned helper requires the exact staging runtime/request Host, one database
staging marker, matching synthetic owner/slug, test-shop tenant and one accepted
server-marked enquiry. The older fresh-shop fixture alone no longer qualifies.
Closed gates retain ordinary delivery, which is refused if sensitive mail cannot
be sent. No server test uses a hosted or production database.

This first stack layer deliberately retains generic wrong-code feedback. The
later layer adds the committed remaining count and the manual, labelled staging
code view plus its dedicated CI seam. This layer alone is not a usable synthetic
returning-login walkthrough, because the existing client cannot display that
code. It preserves normal email delivery and password-only legacy compatibility.
The proof and limit fixes are reused; no schema, signup-owned production,
financial rule, client, generated output or CI change is introduced here.

Full local final-head gates, independent composition review, Linux CI and CTO
protected-auth review remain pending on this new stack head. Earlier reviews
apply to their stated source, not new execution on this commit. #769/#771, the
identifier policy, no-email/device/PIN/recovery/audit and full-pack gates remain.

`tests/e2e/signin-lock.spec.ts` keeps the accepted test-only snapshot/restore of
its two limiter buckets so real lock cases do not poison later desk seams. No
production limiter or financial assertion is weakened.
