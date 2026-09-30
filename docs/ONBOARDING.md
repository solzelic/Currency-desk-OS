# Onboarding — how a desk comes to exist

The reference for the onboarding subsystem: the record model, the build
pipeline, the public API, verification, and provisioning. Everything below
is verified against a running server, driven in Chromium, unless it says
otherwise.

## How a new shop starts

The public page at `/onboarding` is the start. The order is fixed:

1. The person accepts the terms of service (the legal page, version
   dated 26 July 2026), then continues. The server refuses the account
   if that acceptance is missing or for any other version.
2. They sign up. Name, business, email, password. No invite code.
3. The account is created in that request, and the page shows the
   CurrencyDesk ID the desk just issued: `CD-` and six characters,
   stored on `tenants.reference`. It is not a field on the form. A
   request that tries to send one is rejected and creates nothing.

Shop-record upload is not on this page. There is no drop zone. Nothing
is marked read, and nothing is marked verified. That step stays closed
until a file can be encrypted, written onto the real application, and
confirmed by the owner before it is saved.

`/onboarding/CD-XXXXXX` is a different door: the designed wizard, for an
application that **already has** a reference. It is how an invited
application is finished. It is not how a new shop starts, and the bare
page no longer asks anyone to type an ID before they can continue.

## The shape of it

One record per **application**, not per desk — the wizard below still
happens against an application that already exists. Table `onboarding`,
keyed on `enquiry_id`. The account opened at `/onboarding` is a desk
first; it does not wait on that record.

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

This is the continuation for an application that already has a reference.
A new shop does not walk it. They start at `/onboarding`, described above,
and the desk exists before this wizard does.

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

`design/onboarding/account-start.html` → `web/onboarding-start.html`
(the public start, copied as-is).

`design/onboarding/currencydesk-onboarding.html` → `scripts/build-onboarding.mjs`
→ `web/onboarding.html` (the wizard).

Wired into `npm run build`, into the Render `buildCommand`, and CI fails if
the committed page is stale (`git diff --exit-code web/onboarding.html`).

The build parses the design out of the bundle's `__bundler/template` JSON,
patches the **real source**, and re-serializes — reproducing the bundler's
`</` → `</` escaping, without which the page truncates at the design's
own closing script tag. That means every anchor is readable rather than
written in escaped form.

**18 anchors, every one asserted with an expected occurrence count.** A
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

- A bare `/onboarding` is the account-opening page (terms, then the
  account, then the issued ID). It does not use the wizard's
  `localStorage`. The wizard runs only at `/onboarding/:code`.
- Synchronous XHR blocks first paint by roughly the round-trip.
- Once the desk exists, `PUT /state` answers 409. The page keeps autosaving
  for a moment afterwards; the server refusing to overwrite a finished
  onboarding is the correct end of that conversation.
