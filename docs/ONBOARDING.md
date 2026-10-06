# Onboarding — how a desk comes to exist

The reference for the onboarding subsystem: the record model, the build
pipeline, the public API, verification, and provisioning. Everything below
is verified against a running server, driven in Chromium, unless it says
otherwise.

## How a new shop starts

The existing invite chain is the path. There is not a second signup.

1. Home "Get early access" leads to `/signup`, the early-access application. That form is unchanged.
2. Admin "Approve & invite" sends the existing email. It carries their code (`CD-XXXXXX`) and the link `/onboarding/CD-XXXXXX`. That email is unchanged.
3. The link opens on the reference already in it: "This is your ID: CD-XXXXXX". The desk keeps that id. It does not issue a second one. If the application has a shop name, it is shown above the code. The words on this screen are for the customer.
4. The next screen is the Terms of Service dated 26 July 2026. Continue stays off, and looks off, until the box is checked. The server records the version, the time, and who accepted (the application's email). Any other version is refused, and nothing is stored. That refusal is not printed on the screen.
5. Then the existing setup wizard runs: business, money, rules, launch. The account opens at the end, the way it does today. Launch refuses unless those terms are on that reference.

A bare `/onboarding` (no code) redirects to `/signup`. The `/login` "Create your desk" link goes to `/signup`.

`OnboardWizard` in `os-src/cdos-os.jsx` and `POST /api/signup` are still in the tree and unlinked. Removing them is a follow-up.

## The shape of it

One record per **application**, not per desk. Table `onboarding`, keyed on `enquiry_id`. The reference the link shows is `enquiries.reference`. Terms live on the onboarding row (`terms_version`, `terms_accepted_at`, `terms_accepted_by`), with a database check that the version is either unset or exactly `2026-07-26` together with a time and a person.

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
apply at /signup  →  operator presses "Approve & invite"
                  →  email carries the code AND /onboarding/CD-XXXXXX
                  →  the link shows that ID
                  →  they accept the 26 July 2026 terms
                  →  the existing wizard (business, money, rules, launch)
                  →  a 6-digit code to their email, checked server-side
                  →  the desk is created and they are signed in
```

All of it verified in a browser: a real application walked screens 0→16,
`POST /launch` returned 201, `tnt-meridianfx` exists with its owner as
administrator, and the application closed itself to `accepted`.

## The build

`design/onboarding/currencydesk-onboarding.html` → `scripts/build-onboarding.mjs`
→ `web/onboarding.html`.

There is no second start page. Screen 0 of this wizard is two views —
the ID from the link, then the terms — and screens 1–16 are the setup
that was already there. Verify stays screen 14 and the done screen stays
16, because the build's patches are pinned to those numbers.

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
2. **The first two views** — screen 0 shows the reference from the link
   ("This is your ID"), then the 26 July 2026 terms. Continue on the
   terms view stays off until the box is checked. The typed-ID field
   remains in the design source for the design tool and is not what the
   served page shows.
3. **Identity** — the design validated `CD-XXXX-0000`, a format we have
   never issued. The served page takes the real `CD-XXXXXX` from the path.
4. **Never the demo desk** — the bundle defaults to `prefillDemo:true`.
   Served live, the flow starts empty. (Both call sites: initial state *and*
   "start over".)
5. **Verification** — email instead of SMS, worded from the live channel.
6. **The ending** — the code is checked and the desk is created.
7. **The `componentDidUpdate` defect** — the runtime forwards only
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

- `GET  /api/onboarding/:ref/state` → `{ at, data, application, verify, terms }`.
  `application.reference` is the code in the link. `terms` is the
  26 July 2026 offer and whether this reference has accepted it.
  Blanks in `data` are seeded from the application (only blanks).
- `POST /api/onboarding/:ref/terms` → `{ termsAccepted: true, termsVersion: "2026-07-26" }`
  only. The server writes the version, the time, and the application's
  email. Any other version, or a body that names who accepted, is
  rejected and stores nothing.
- `PUT  /api/onboarding/:ref/state` → the whole blob, debounced by the page.
  Refuses with `terms_required` until the terms for this reference are on the row.
- `POST /api/onboarding/:ref/verify/send` → issues and sends a 6-digit code.
  Same refusal until the terms are accepted.
- `POST /api/onboarding/:ref/verify/check` → 5 attempts, 10-minute expiry
- `POST /api/onboarding/:ref/launch` → creates the desk, signs them in.
  Refuses with `terms_required` unless the terms for this reference were accepted.

**Four things are never stored in answers**: the card (`cardNum`, `cardCvc`,
`cardExp`, `card2*`, `backup`), the password (`ownerPass`), the terms
checkbox (`termsChecked` — acceptance is the three columns, not a flag
in the blob), and anything under a `__` key — or a browser could mark
itself confirmed.

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

- A bare `/onboarding` redirects to `/signup`. The wizard runs only at
  `/onboarding/:code`.
- `/login` "Create your desk" goes to `/signup`. `OnboardWizard` and
  `POST /api/signup` are still in the tree, unlinked, and are a follow-up
  removal.
- Synchronous XHR blocks first paint by roughly the round-trip.
- Once the desk exists, `PUT /state` answers 409. The page keeps autosaving
  for a moment afterwards; the server refusing to overwrite a finished
  onboarding is the correct end of that conversation.
