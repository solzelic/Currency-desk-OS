# Onboarding — where it stands, and what's next

Written at the end of the session that built it. Everything below is on
`main` and verified against a running server unless it says otherwise.

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

## The chain

```
apply on the site  →  operator presses "invited" in the panel
                   →  email carries the code AND a link containing it
                   →  /onboarding/CD-XXXXXX
                   →  17 screens, saving as they go
                   →  (not yet) create the desk + take payment
```

## The build

`CurrencyDesk Onboarding.html` (repo root, the design's standalone dc
bundle) → `scripts/build-onboarding.mjs` → `web/onboarding.html`.

**Run `node scripts/build-onboarding.mjs` after every design re-export.**
It is not wired into `npm run build` yet — see Next, below.

The build changes three things and nothing else. Every anchor is asserted,
so a re-export that moves one fails loudly rather than shipping a page that
has quietly stopped saving.

1. **Save** — injects into the design's own persist call so answers go to
   the server as well as `localStorage`.
2. **Hydrate** — a bridge script at the top of `<body>` fetches the server's
   copy with a *synchronous* XHR and writes it into `localStorage` before any
   bundle script runs. Deliberately not a fetch: the dc runtime boots itself,
   so racing it passes on a fast connection and fails on a shop's.
3. **Guard** — the dc runtime forwards only `prevProps` to
   `componentDidUpdate`, so the design's `prevS.i` throws on every update.
   `scripts/build-site.mjs` patches the same defect in `support.js` for the
   site pages; here the runtime is inside a bundled blob, so the guard goes
   on the design's own handler instead.

If a re-export renames the storage key (`cdos_onb_v2`) the build says so.

## The API

Public, no session — the code is the key, same trust model as any emailed
link. Only an **invited** or **accepted** application opens. Rate limiting
counts *misses* per IP, never saves, so somebody working through their own
setup is never throttled.

- `GET  /api/onboarding/:ref/state` → `{ at, data, application }`, blanks
  seeded from what they told us on the application (only blanks — an answer
  they have since changed is theirs)
- `PUT  /api/onboarding/:ref/state` → the whole blob, debounced by the page

**Card and password are stripped before anything is stored** (`cardNum`,
`cardCvc`, `cardExp`, `card2*`, `ownerPass`). The card goes to Stripe from
the browser. A saved PAN is a liability nobody asked us to take on.

Admin-side equivalents live in `server/src/routes/onboarding.ts`.

## The walkthrough

`CD-WALKTHRU` — a permanent application seeded on every boot
(`server/src/onboarding/walkthrough.ts`). Open it any time to run the whole
thing. It counts towards nothing: not the site's "N of 100 desks claimed",
not the panel's funnel, and it holds no charter number. **Start over** resets
it; only it can be reset.

## Next, roughly in order

1. **Launch doesn't create a desk.** The last screen says "You're live" and
   reloads. It needs to POST to `/api/signup` with the collected answers and
   take payment. This is the biggest remaining gap.
2. **Stripe.** The design collects card fields; nothing charges. Decide
   subscription-per-plan vs setup fee, then wire Stripe Elements in the
   browser so the PAN never reaches us.
3. **The admin panel is showing stale fields.** `server/src/onboarding/flow.ts`
   is a nine-step spec *I invented* before the design existed. The design
   supersedes it — the panel should render the design's real field list so
   both surfaces speak one language. Right now they have diverged.
4. **Wire the build into `npm run build`** so a deploy can't ship a stale
   `web/onboarding.html`.
5. **Make the panel mirror the applicant's flow** — the ask was that they
   look almost the same. Currently the panel is a dark form and the
   applicant's is the designed bundle.

## Known and deliberate

- A bare `/onboarding` with no code works on `localStorage` alone and never
  syncs. That is correct: without a code the server cannot know whose setup
  it is.
- Synchronous XHR blocks first paint by roughly the round-trip. Accepted, for
  the reason in Build (2) above.
- `onb-desktop.png` in the repo root is a render of the *old* design and can
  probably go.

## Still outstanding from earlier in the session

- Admin password `12345`, reset every deploy by `PLATFORM_ADMIN_BOOTSTRAP`.
- Rotate the Resend API key.
- The panel's sign-in field is `type=email`, so a non-email admin id cannot
  be typed into it.
- Add-ons design is truncated and needs a re-export.
- The Rate Board still lives in `YorkFX/` and should move into the product;
  the landmine there is the `yorkfx_*` localStorage keys, which need a
  migration or every published board is orphaned.
