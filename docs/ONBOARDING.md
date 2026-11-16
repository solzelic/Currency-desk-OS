# Onboarding — how a desk comes to exist

The reference for the onboarding subsystem: the record model, the build
pipeline, the public API, verification, and provisioning. Everything below
describes the legacy flow unless it says v2.1. Historical Chromium evidence
below does not cover the v2.1 server corrections or its still-missing page.

## The shape of it

One record per **application**, not per desk — because all of this happens
before a desk exists. Table `onboarding`, keyed on `enquiry_id`.

Two surfaces work the same record:

| Who | Where | Auth |
|---|---|---|
| The applicant | `/onboarding/CD-XXXXXX` | the code itself |
| Platform team | `/admin#/onboarding/CD-XXXXXX` | platform admin session |

So a desk set up at the counter on Tuesday is finished by its owner on
Wednesday, and neither has to ask the other where they got to.

**Both surfaces now read and write one field list — the design's.**
`server/src/onboarding/flow.ts` used to be a nine-step spec invented before
the design arrived, and the two were quietly disagreeing about what a desk
even has. It is now the design's own screens and the design's own field
names (`operatingName`, `bizName`, `ownerEmail`, `idOver`, `compName`…),
stored flat in `onboarding.answers`. There is no translation layer, because
a translation layer goes stale every time a screen changes.

## The chain

```
apply on the site  →  operator presses "invited" in the panel
                   →  email carries the code AND a link containing it
                   →  /onboarding/CD-XXXXXX  (code already filled in)
                   →  17 screens, saving as they go
                   →  a 6-digit code to their email, checked server-side
                   →  the desk is created and they are signed in
```

All of it verified in a browser: a real application walked screens 0→16,
`POST /launch` returned 201, `tnt-meridianfx` exists with its owner as
administrator, and the application closed itself to `accepted`.

## The build

`design/onboarding/currencydesk-onboarding.html` (the design's standalone
dc bundle) → `scripts/build-onboarding.mjs` → `web/onboarding.html`.

Wired into `npm run build`, into the Render `buildCommand`, and CI fails if
the committed page is stale (`git diff --exit-code web/onboarding.html`).

The build parses the design out of the bundle's `__bundler/template` JSON,
patches the **real source**, and re-serializes — reproducing the bundler's
`</` → `<\u002F` escaping, without which the page truncates at the design's
own closing script tag. That means every anchor is readable rather than
written in escaped form.

**50 anchors, every one asserted with an expected occurrence count.** A
re-export that moves one fails the build loudly. The count matters as much
as the match: two call sites where we thought there was one means half the
page kept the old behaviour — which is exactly how the "start over" button
was found still loading the demo desk.

What it changes, and nothing else:

1. **Save / hydrate** — answers go to the server as well as `localStorage`,
   and the server's copy is written in by a *synchronous* XHR before any
   bundle script runs. Deliberately not a fetch: the dc runtime boots
   itself, so racing it passes on a fast connection and fails on a shop's.
2. **Identity** — the design validated `CD-XXXX-0000`, a format we have
   never issued. It now takes the real `CD-XXXXXX`, and the code from the
   link arrives already filled in and "Recognised".
3. **Never the demo desk** — the bundle defaults to `prefillDemo:true`.
   Served live, the flow starts empty. (Both call sites: initial state *and*
   "start over".)
4. **Verification** — email instead of SMS, worded from the live channel.
5. **The ending** — the code is checked and the desk is created.
6. **The `componentDidUpdate` defect** — the runtime forwards only
   `prevProps`. The old guard substituted `this.state`, which stopped the
   throw but made "the screen changed" permanently false, so `focusStage`
   never ran. The build now keeps its own note of the screen.

## Verification: email now, phone later

The design confirms a mobile by text. There is no SMS provider, so the code
goes to the owner's **email** — the address the invite already reached and
the thing they sign in with.

One constant is the whole switch:

```
VERIFY_CHANNEL = "email" | "phone"     (server/src/routes/onboarding-public.ts)
```

The server sends over it, `GET /state` reports it, and the page words itself
from it — question, help text, "No email yet?" vs "No text yet?", "Wrong
address?" vs "Wrong number?". Setting `VERIFY_CHANNEL=phone` on a box with
Twilio credentials moves the whole flow back to SMS without a screen
changing or a rebuild. `sendSms`/`normalizePhone` are already wired on that
branch. The mobile number is collected and stored either way.

## The API

Public, no session — the code is the key, same trust model as any emailed
link. Only an **invited** or **accepted** application opens. Rate limiting
counts *misses* per IP, never saves.

- `GET  /api/onboarding/:ref/state` → `{ at, data, application, verify }`,
  blanks seeded from the application (only blanks)
- `PUT  /api/onboarding/:ref/state` → the whole blob, debounced by the page
- `POST /api/onboarding/:ref/verify/send` → issues and sends a 6-digit code
- `POST /api/onboarding/:ref/verify/check` → 5 attempts, 10-minute expiry
- `POST /api/onboarding/:ref/launch` → creates the desk, signs them in

**Three things are never stored**: the card (`cardNum`, `cardCvc`,
`cardExp`, `card2*`, `backup`), the password (`ownerPass`), and anything
under a `__` key — or a browser could mark itself confirmed.

Because the password is never stored, **it does not survive a device
change**. Somebody who sets it on the shop laptop and finishes on their
phone is sent back to the account screen with the reason, rather than
failing under a button on the last screen. Verified by resuming a
half-finished setup in a second browser.

## Creating the desk

`server/src/onboarding/provision.ts` — one function, two doors
(`/api/signup/verify` and `/api/onboarding/:ref/launch`), so they cannot
build different things.

- The desk address is never asked for. It comes from the workspace they
  picked on their application, falling back to the shop name, and
  `freeSlug` finds a free one rather than refusing at screen 15.
- The team they listed gets real staff accounts, with the design's role
  names mapped to the ones authorization is written against (Manager →
  `branch_manager`, Cashier → `teller`…). They arrive needing a password
  set — we have no business inventing one. Somebody named without an email
  is recorded but given no account: a login nobody can reach looks like it
  works.
- Everything the design collected lands on `tenants.setup` in the design's
  own words — compliance officer, spreads, opening float, publish mode,
  addons, term, billing address, ID threshold. The mobile is on that blob.
  The number an admin call dials is `enquiries.details.phone`. When a
  Canada desk opens and that field is empty, the setup mobile is copied
  across in the same shape the early-access form already stores. It does
  not dial.
- Plans: the design sells `rates`/`full`/`ai`; the server gates on
  `basic`/`pro`/`premium`. `rates`→`basic`, and both `full` and `ai`→
  `premium` with `setup.aiBundle` recording the difference. **Assumption:**
  "Full System — the complete exchange desk" should not be under-entitled,
  and the AI bundle is a product flag rather than a fourth access level.

## The walkthrough

`CD-WALKTHRU` — a permanent application seeded on every boot. It now runs
the *whole* flow including the ending: a real code is issued and must be
typed (it goes to the log instead of an inbox), `/launch` runs, and the one
thing it does not do is create a desk. Verified: after a full browser run
its `tenantId` is still null and its status still `invited`.

## Known and deliberate

- A bare `/onboarding` with no code works on `localStorage` alone and never
  syncs. Without a code the server cannot know whose setup it is.
- Synchronous XHR blocks first paint by roughly the round-trip.
- Once the desk exists, `PUT /state` answers 409. The page keeps autosaving
  for a moment afterwards; the server refusing to overwrite a finished
  onboarding is the correct end of that conversation.

## Sign-up v2.1: the CurrencyDesk ID door (PR 1 of 8)

The v2.1 sign-up (Sol's pack, 14 Nov) is keyed on the owner's CurrencyDesk ID, not on the setup reference. Both doors live side by side until the v2.1 page replaces the older one.

- `GET /api/onboarding/:id/state` with an ID gives `{ valid, operatingName, state }` and nothing more. The ID identifies the reservation; it does not authenticate. The credential, the email code and the PIN do that (later PRs).
- Which door answers: a value that compacts to `CD` + 4 letters + 4 characters from the ID alphabet is an ID, unless a setup reference with that exact text exists, which keeps the older page.
- Misses: per ID and per connection, 10 in 15 minutes, then 15 minutes closed. In memory, so the counts reset on restart and are per instance. Each table remembers 10,000 keys and forgets the one seen longest ago, so a flood never refuses a key it has not seen.
- `POST /api/onboarding/resend-id`: always 202; the lookup and the send run after the reply.
- Reissue is a platform action (`POST /api/admin/enquiries/:id/reissue-cd-id`); the old ID stops matching at once.
- Logs: IDs as their last four characters, emails as a 16-character SHA-256 prefix.

## Sign-up v2.1: choosing a credential (PR 2 of 8)

- `POST /api/onboarding/:id/passkey/options` then `…/passkey/verify`; `GET …/sso/:provider/start` (returns the provider URL) then `POST …/sso/callback { provider, code, state }`; `POST …/password { password, confirm }`.
- Every one needs the browser's `cd_enrol_attempt` cookie for its second half, and saves a candidate credential (`verified_at` null). The email code (PR 3) verifies only the candidate whose attempt matches the browser that typed the code.
- Configuration: `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` (comma list); `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `SSO_REDIRECT_URI`. Unset or unusable, that way in answers 503 and `GET /api/onboarding/methods` reports it unavailable (see "Real provider configuration" below).
- Microsoft (corrected 16 Nov 2026): Microsoft's ID-token and optional-claims references list no `email_verified` claim, and say `email` is mutable and not for authorization. There is no optional claim to switch on. Under the pack's rule (`email_verified` true), every Microsoft account is refused, now as `409 email_unverified` with its own message rather than "isn't the email you applied with". Any other rule for Microsoft is a protected spec exception for CTO.
- Timeouts: OIDC token and keys 8 s, breach range 3 s. A token-endpoint 4xx (a spent or foreign code) is `400 sso_not_saved`; a 5xx, timeout or network failure is `502 sso_unavailable` and does not count against the ID's 10 misses.

## Real provider configuration (16 November 2026)

Nothing here is a secret; the values below are names and public URLs. Secrets
live only in the Render dashboard of the service they belong to.

| Key | Staging (`currencydesk-staging`) | Production (`currencydesk`) |
| --- | --- | --- |
| `WEBAUTHN_RP_ID` | the staging page's own host, e.g. `staging.currencydeskos.com` (or `currencydesk-staging.onrender.com` if sign-up is served only there) | `currencydeskos.com` (CTO to confirm; permanent) |
| `WEBAUTHN_ORIGINS` | the exact origin(s) the sign-up page is served from under that RP ID, e.g. `https://staging.currencydeskos.com` | e.g. `https://www.currencydeskos.com,https://currencydeskos.com` |
| `SSO_REDIRECT_URI` | `https://<staging page origin>/onboarding/sso` | `https://<production page origin>/onboarding/sso` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | a staging-only Google OAuth client (type Web application), authorized redirect URI exactly the staging `SSO_REDIRECT_URI` | a separate production client, its own redirect URI |
| `MICROSOFT_CLIENT_ID` / `_SECRET` | a staging-only app registration: any organizational directory and personal Microsoft accounts (`common`), platform Web, redirect URI exactly the staging `SSO_REDIRECT_URI`, a client secret | a separate production registration |

`SIGNUP_MICROSOFT_EMAIL_PROOF` (unset by default; protected spec exception,
set only with CTO's recorded approval): `signup_code` lets a Microsoft account
whose signed token carries `email` equal to the reservation email be saved as a
candidate, with the sign-up's own 6-digit code to that email, typed in the same
browser, as the email proof. Unset, Microsoft is not offered (`/methods` says
`microsoft:false`), because Microsoft never sends the `email_verified` the pack
requires. Either way: `email_verified` or `xms_edov` explicitly false,
another email, or no email are refused, and `preferred_username` / UPN are
never read.

Rules the server enforces, so a mistake shows as "not offered" rather than a
broken button:
- The RP ID must have a dot (or be `localhost`) and must not be a shared
  hosting suffix such as `onrender.com` (browsers refuse public suffixes).
  Every origin must be `https://` on the RP ID or a subdomain of it (`http://`
  only for `localhost` outside production).
- `SSO_REDIRECT_URI` must be exactly `<origin>/onboarding/sso`: `https://`
  (`http://localhost` outside production only), no user, query or fragment.
- The page offers the passkey only when its own `location.origin` is in
  `WEBAUTHN_ORIGINS`, and Google/Microsoft only when it is on the redirect's
  origin. The popup and the phone return can hand back only to that origin.

Separation: staging and production never share an RP ID, a Google client or
a Microsoft registration. With RP ID `currencydeskos.com` on staging, staging
passkeys would be offered on the live sign-in. Microsoft's `sub` is pairwise
per application, so each registration yields different subjects for the same
person; links made on staging never apply to production and must never be
copied there. Google's `sub` is the same person everywhere; separate clients
and databases keep staging links out of production.

Safe presence check, after a deploy (no secret, client ID or email in the answer):

```bash
curl -s https://<origin>/api/onboarding/methods
# {"password":true,"passkey":true,"passkeyOrigins":["https://…"],"google":true,"microsoft":true,"ssoOrigin":"https://…"}
```

`false` for a configured provider means its keys or `SSO_REDIRECT_URI` failed
validation; `passkey:false` means the RP ID or an origin did. Real provider and
hardware sign-ups remain unrun until these are set: a mocked provider is not a
real Google or Microsoft success, and a synthetic `staging.invalid`
reservation email cannot equal a real provider account's email, so a real
provider test needs a reservation made with a real inbox the tester controls.

## Stable credential contract for sign-in (CD-221)

Sign-up writes; sign-in reads. Owned by sign-up: `server/src/onboarding/{signup-account,passkey,sso,email-code}.ts`, `server/src/routes/signup-credential.ts`, migration 075.

- `signup_credentials` row per saved way in, `enquiry_id` → `enquiries` (the reservation: `cd_id`, `email`). Only rows with `verified_at` set are the owner's; candidates (`verified_at` null) are tied to one browser's `attempt_hash` and are deleted when another candidate is verified.
- `kind = 'passkey'`: `passkey_id` (base64url credential ID, unique), `public_key` (base64url COSE key), `sign_count`, `transports`, `aaguid`, `backup_eligible`, `backup_state`, `device_label`. Registered with user verification required, ES256/RS256, discoverable, under the `WEBAUTHN_RP_ID` in force at registration (not stored per row: never change a deployment's RP ID). `signup_accounts.account_id` is the WebAuthn `user.id` (UTF-8 bytes); `user.name` is the CD ID.
- `kind = 'google'`: `sso_subject` = the ID token's `sub`; `sso_tenant` null.
- `kind = 'microsoft'`: `sso_subject` = the ID token's `sub` (pairwise for that client ID), `sso_tenant` = `tid`.
- A verified `(kind, sso_subject)` is unique (partial index in 075).
- `kind = 'password'`: `password_hash` (Argon2id, `verifyPassword` reads it); at activation it is also copied to the owner's staff row. Passkey and Google/Microsoft owners get a random unusable staff password.
- `signup_accounts.state`: `reserved → enrolling → verified → active`. Activation (`signup-open.ts`) provisions the tenant and owner staff row and copies the CD ID and PIN hash to it.
- Returning sign-in must identify a provider account only by verified `(kind, sso_subject[, sso_tenant])` from a freshly verified token (signature, issuer, audience, nonce, time), never by `email`, `preferred_username` or UPN, and must not create or link a new row; a passkey only by `passkey_id` plus an assertion verified against `public_key`, `sign_count` and UV. `saveCredential` and the email-code state machine are sign-up only.

## Sign-up v2.1: the email code and the enrolment session (PR 3 of 8)

- The code is sent on every credential save and by `POST …/email/send`; it always goes to `enquiries.email`, never to an address in the request, so there is no destination to rebind (the CD-154 concern on the older path does not arise here).
- `POST …/email/verify` needs the attempt cookie of a browser holding a candidate credential. Success sets `cd_enrol` (24 h sliding). Only `enrolment_sessions.token_hash` is stored.
- Status codes: 401 wrong, 410 expired, 423 five wrong, 429 too soon, 409 nothing waiting.


## CD-206 server review corrections (15 November 2026)

New v2.1 passwords and PINs use Argon2id (node-argon2 0.45.2, pinned; reference
implementation with Node 22 support), 64 MiB, three iterations, one lane.
Existing scrypt hashes and writers remain compatible through the common verifier.
The dependency is required by the supplied build pack; npm's audit reports no
advisory for argon2 or its new dependencies. Existing server dependency advisories
remain, and this is not a clean dependency-audit claim.

Passkeys require explicit `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS`; missing or
mismatched origins return unavailable. The ID/shop labels preserve pre-proof
privacy; returning private email/name in registration JSON would violate it.
OIDC checks authorized party and future validity as well as signature, issuer,
audience, expiry, nonce and the exact normalized verified email. No provider token
or authenticator error contents are logged by these adapters. Empty/malformed
breach-range replies are unavailable, never evidence that a password is safe.

The Astra server review serializes candidate replacement, code sends and code verification on the signup account row. A browser's latest unverified choice replaces its previous candidate; a delayed save after proof refuses. Verification, candidate cleanup, audit and session creation commit together. Real PostgreSQL regressions cover concurrent sends, attempts and successful verification.

Reservations with a CurrencyDesk ID refuse all legacy reference setup routes and plain signup/create/verify/resend, including stale pending plain-signup codes. Older reservations without an ID keep their existing route. Signup request/error logs redact identifiers, query secrets and raw database/provider errors. Signup code/ID mail marks its body sensitive: no simulation or provider echo in logs, even in development; use an injected test mailer locally.

Astra payment corrections: all answer edits, confirmation, payment preparation and activation serialize on the account row. Editing answers invalidates the saved intent/plan as well as the signature. SetupIntent/customer calls carry deterministic Stripe idempotency keys; activation checks the exact intent, customer, successful status, payment method and agreement hash. Signup alone uses a 15-second/no-automatic-retry Stripe client; unrelated billing retains its previous client settings. Prices are CAD integer minor units (`perLocationMinor`, `totalMinor`, `dueTodayMinor`, `setupWeekMinor`); annual Full is 53910 cents/location. Unsupported billing packs and the coming-soon website extra refuse. These fields replace the prototype-era whole-unit API response.

Only an application still Invited opens: an early access row with its CurrencyDesk ID. Both the card webhook and the staging no-card Open lock the enquiry row under the account lock and refuse anything else (declined, on hold, in review) with `not_invited`, leaving the account, intent and plan untouched and writing a `signup.open_refused` audit row. The webhook answers 200, so Stripe does not retry, and deletes its `stripe_events` claim on the refused event. A card the owner confirms with Stripe.js after a decline therefore opens nothing. Stripe sends one `setup_intent.succeeded` per intent and `POST …/plan` hands back that same intent while its Stripe idempotency key lasts (24 hours), so there is no automatic re-open: if support invites the application again, resending that event from the Stripe dashboard or CLI (it keeps its event id) opens the desk, and only an opening keeps the claim. The saved card stays on the Stripe customer; nothing detaches it yet. `POST …/open` issues the desk session only when the application is accepted for that very tenant. Pipeline moves are compare-and-set on the stage they were read at, so a decision made on a stale read answers `changed` and never overwrites an opened desk.

Activation commits desk, owner, account, enquiry and audit together, refuses existing-tenant collisions, and converts the enrolment token into at most one desk session. Staff names derive from first/last. Migration 079 makes an explicit zero desk ID threshold mean every exchange; NULL still follows the pack. The real ledger posting regression refuses a one-cent unidentified exchange. Protected auth, money, provisioning and schema changes require CTO review. Rollback must preserve an every-exchange policy: do not clear zero values or restore an incompatible constraint as an automatic rollback.

Still outside server acceptance: first-deal subscription activation, staff invitation/CD-ID lifecycle, initial vault count posting, additional shop slots, SAM opt-in evidence, expired-session resume/known-device flow and all signup UI/Day 1/tour work require completion and a final integrated review.

Support reissue now serializes against signup mutation, retires the old ID's hash, and clears outstanding codes/challenges/unverified candidates. Delayed credential/code requests against the prior ID refuse; authenticated ownership is retained. Credential work is additionally limited before expensive hashing/provider calls (12 requests per ID and 30 per connection per 15 minutes). The ID counts only once it names a reservation, and an unknown ID is a miss against the connection alone; these request/ID-miss/resend brakes remain process-local, while code-send and attempt limits are database-serialized. Multi-instance durable abuse protection remains a release review consideration.

The existing Places routes now accept the scoped v2.1 enrolment session and derive the country from the reservation. SAM opt-out appends the existing stop-consent record and cancels its scheduled call even when subsequent card setup fails. Selecting SAM again does not manufacture new opt-in evidence; that UI/consent integration still needs completion.


Migration 080 adds append-only `signup_agreements`: typed signer, account,
declaration version, canonical answer hash, signed snapshot, pack identity/version,
and selected plan/price/intent evidence. Service terms are pinned to the frozen
prototype fragment hash in `SERVICE_AGREEMENT_SOURCE_HASH`; this is draft-source
provenance, not proof that the missing page displayed those terms. Do not delete
or rewrite signed records when progress is edited. Final UI must display the
reviewed version and confirm the evidence matches it.

Activation copies applied phone, unit, home/selected currencies and the named
compliance contact into the desk. "Me" means the verified reservation's owner,
not an empty contact. Naming another officer is required before signing in that
mode; this does not itself appoint an officer legally or create their account.
Trusted staging runtime + stored staging marker + synthetic owner are all needed
to retain `isTestShop`; production cannot acquire it from the marker alone.
`setup.signup.vaultCountStatus` explicitly reports deferred/pending ledger work.
No opening count is treated as a cash balance. Signup confirmation/pricing and
migration changes still require protected-surface CTO review.

PIN changes and their audit event now commit together under the account lock.
Every onboarding 409/410/423/429 response logs a bounded machine reason and
status, without response detail, code, credential or card data.

### Integrated page review: agreement and rendering

The frozen v2.1 design remains source. `build:signup` applies counted bridge
patches and `scripts/signup-aot.mjs` compiles its conditions, loops and markup
to ordinary React calls in `web/app/signup.js`. Unknown constructs fail the
build. React stays pinned and self-hosted; signup no longer loads `support.js`
or evaluates a logic class in the visitor's browser. No generated file is edited.

Opening Payment calls authenticated `POST …/payment` to prepare a SetupIntent
without agreement assent. The explicit Open action calls `POST …/agreement`
with the current intent and displayed source hash before Stripe confirmation.
Acceptance binds the current plan, answer signature and intent; answer edits
invalidate it. Legacy `POST …/plan` still requires explicit `agreed: true`.
This does not complete first-exchange subscription activation or legal approval.

### Signup call preference

Post-proof resume returns the current SAM permission, exact consent sentence and
SHA-256 version, a masked phone and a target binding for the current number. The
page reflects that evidence; an absent answer is not a pre-ticked consent. An
existing Early Access consent counts only while its text and phone still match.
Authenticated `POST …/preferences` saves opt-in, stop and reconsent under the signup
account lock. Consent rows preserve the exact sentence, number, timestamp, IP and
user agent; the audit links the immutable evidence to the verified account without
copying phone/IP into audit detail. Retries do not duplicate the same choice.

Opt-out cancels the saved schedule immediately, independently of payment. Tenant
activation reads the latest consent rather than reviving an older plan's choice.
The existing Early Access booking route shares that lock and rechecks the latest
permission, so a queued booking cannot restore a schedule after an opt-out.
Reconsent does not schedule or place a call. Calling-service integration, holiday
hours, sales permission and Compliance's wording approval remain separate gates.

### v2.1 setup fidelity (review in progress)

An explicit `idOver: "0"` means every exchange. Activation stores zero in both
legal-entity policy and tenant setup in its existing transaction; the OS retains
zero even when the policy currency differs (zero needs no conversion). Positive
foreign-currency policy still requires the authoritative conversion path.
Opening counts remain draft amounts by currency, not posted cash. The page shows
“Not posted” and the review says “Count saved by currency”; it does not value the
count using prototype sample rates. The authoritative opening-position handoff
and its PIN/declaration contract remain open with CTO.

Payment recovery retries preparation explicitly, including script-load timeouts
and provider construction/mount failures. Returning from a provider clears its
query from history and calls the existing `/open` boundary; URL values are never
proof. The unspent enrolment cookie plus webhook-activated account remain
required. Page responses use no-store/no-referrer and application logs omit page
queries. Reverse-proxy/CDN query logging must be checked separately before live
provider acceptance (CD156); no infrastructure configuration is assumed here.
