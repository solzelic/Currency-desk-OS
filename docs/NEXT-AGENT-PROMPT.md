# Prompt for the next agent

Copy everything below the line.

---

You're continuing work on **CurrencyDesk**, a multi-tenant SaaS for
currency-exchange shops. Live at www.currencydeskos.com, one real customer
(York FX), onboarding the first 20–40 by hand. Work on branch
`claude/login-signup-process-pibvxw`; `main` is current and deployable.

**Read `docs/ONBOARDING-HANDOFF.md` first.** It has the record model, the
build pipeline, the API and its trust model, and the known gaps. Don't
re-derive any of it.

## The end goal

**A shop owner goes from applying on the site to taking their first
trade without anyone touching a database — and the operator can drive,
watch, or override every step of that from `/admin`.**

You are done when all of this is true, verified in a browser against a
running server:

1. Someone applies at `/signup`, the operator presses **invited** in the
   panel, and an email arrives with their code and a link.
2. That link opens the designed onboarding, already carrying what they
   told us, and remembers where they stopped across devices.
3. They pay. The card never touches our servers.
4. The desk is created, the owner gets their sign-in, and they can log in
   and trade. No manual step in between.
5. The operator can do every part of that themselves, on the customer's
   behalf, from the panel — and can see, trigger and undo it.

## What already works (don't rebuild it)

- Application → invite → emailed code → `/onboarding/CD-XXXXXX`
- The onboarding record, keyed on the **application** not the desk, with
  both surfaces writing to it
- The design bundle compiled and served, saving to the server, hydrating
  before boot
- `CD-WALKTHRU`, a permanent rehearsal application that counts for nothing
- Invite-gated signup, staff PINs held server-side, the platform panel

## What to build, in order

**1. Launch actually creates the desk.**
The last onboarding screen says "You're live" and reloads. Nothing is
created. Wire it: collect the answers, POST `/api/signup`, verify the
emailed code, create the tenant + owner, mark the application accepted and
stamp `tenantId` on the onboarding row. The customer should end up signed
in, or one click from it.

**2. Stripe.**
The design collects card fields; nothing charges. Use Stripe Elements or
Checkout so the PAN never reaches us — the state endpoint already strips
`cardNum`, `cardCvc`, `cardExp`, `card2*` and `ownerPass` before storing,
and it must stay that way. Payment gates launch. Ask the user whether it's
a subscription per plan or a setup fee before building; plans and prices
are already in the design (`PLANS`, with `mo` values).

**3. Reconcile the panel to the design.**
`server/src/onboarding/flow.ts` is a nine-step spec I invented *before* the
design arrived. The design supersedes it. The panel and the applicant's
flow have diverged and must be brought onto one field list — the design's.
The user's words: the panel should "mirror and almost look the exact same".

**4. Automations.**
Things that should happen without anyone remembering:
- invite email when an application moves to `invited` (exists — fold it in)
- a nudge when somebody stalls mid-onboarding for N days
- receipt and welcome when payment clears
- a warning to the operator when a desk hasn't traded in N days

Build this as **events → rules → actions**, stored, not hard-coded in
route handlers. Every automated action must be visible in the panel with
what fired it and when, and must be individually disableable. An
automation nobody can see or stop is a liability.

**5. Manual triggers, everywhere the automation can act.**
The operator must be able to fire the same actions by hand: resend the
invite, nudge, comp a payment, skip a step, force-create the desk, reset
onboarding. Same code path as the automation, recorded the same way.

## How to work

- **Verify in a browser, not just tests.** Boot the server and drive it
  with Playwright. Tests passing is not evidence the screen works — that
  distinction has already caught several real bugs this project.
- **Run the server suite from `server/`.** From the repo root vitest picks
  up the Playwright e2e specs and reports false failures.
- **Assert every injection anchor.** `scripts/build-onboarding.mjs` and
  `build-site.mjs` patch designed HTML; a moved anchor must fail the build
  loudly, never ship a page that has quietly stopped working.
- **Say what's actually true.** If something is unverified, say so.

## Landmines

- `scripts/build-onboarding.mjs` is **not** in `npm run build` yet. Wire it
  in, or a deploy will ship a stale page after a design re-export.
- In the sandbox, CDNs are blocked: serve React/Babel/Tailwind from
  `node_modules` via Playwright route interception, and launch chromium
  from `/opt/pw-browsers/chromium`.
- There is **no outbound access to currencydeskos.com** from the sandbox.
  Verify against localhost; you cannot check production.
- A Playwright `goto` that only changes the URL hash does not reload —
  call `reload()` or the app never re-boots.
- The admin panel's sign-in field is `type=email`, so a non-email admin id
  can't be typed in. Authenticate via `/api/auth/login` in-page for tests.

## Also outstanding

- Admin password is `12345`, reset every deploy by
  `PLATFORM_ADMIN_BOOTSTRAP`. Fix properly.
- Rotate the Resend API key.
- Add-ons design is truncated; needs a re-export from the user.
- The Rate Board still lives in `YorkFX/` and belongs in the product. The
  landmine is the `yorkfx_*` localStorage keys — they need a migration or
  every already-published board is orphaned.
- `onb-desktop.png` in the repo root renders the *old* onboarding design
  and can probably go.

## Ask before assuming

Two decisions are the user's and change what you build:
- **Stripe**: subscription per plan, or setup fee?
- **Documents**: the flow mentions registration certificates and ID. Real
  file upload needs object storage — this container is ephemeral, so local
  disk loses everything on deploy. Postgres or S3/R2, or record-that-you-
  sighted-it. Don't guess.

Everything else: make the call, state the assumption, and keep building.
