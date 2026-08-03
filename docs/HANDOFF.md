# CurrencyDesk OS — Session Handoff

> **Superseded, 2026-08-03.** This was the source of truth as of 2026-07-22.
> It is no longer maintained — `docs/ARCHITECTURE.md` is how the system is
> built, `docs/NEXT-PUSH.md` is what to do next, and `docs/DEVELOPMENT.md` is
> how to run it. The "paste this as your first message" block at the top is
> stale (it says to expect 69 passing tests; there are now ~400).
>
> **Its §6 "Next 10 things", re-checked against the code:**
>
> - **#1 admin bootstrap** — the hardcoded `12345` is gone from the code;
>   `PLATFORM_ADMIN_BOOTSTRAP` is an env var with no default. *Whether it is
>   still set in Render is yours to confirm — nothing in the repo can tell.*
> - **#2 rotate the Resend key** — operational, can't be verified from here.
>   Assume still outstanding unless you did it.
> - **#3 `/api/auth/login` bypassing 2FA** — **done.** It now refuses any
>   account whose identity is an email with `code_required`, so the emailed
>   code cannot be walked past. Staff ids that aren't addresses stay
>   single-factor because there is nowhere to send a code; that's documented
>   at the call site.
> - **#5 the `CD-YORK-0042` scheme** — **done** (`src/auth/cdid.ts`), issued
>   on demand, unique platform-wide, accepted at sign-in.
> - **#4 new desks starting spotless** — largely done; a fresh desk opens on
>   its own name with an empty ledger.
>
> Everything still outstanding from that list has been folded into
> `docs/NEXT-PUSH.md`. Kept for the history, and because §7 "Gotchas" is
> still worth reading.


_Last updated: 2026-07-22. Status: **LIVE on the web** at https://www.currencydeskos.com_

> **This file is the source of truth for where the project stands. Keep it
> updated at the end of every working session.**

## ▶ To continue in a new session — paste this as your first message

> "Read `docs/HANDOFF.md` in this repo — it's the current source of truth for
> CurrencyDesk OS, which is now LIVE at www.currencydeskos.com. Confirm the live
> status (`curl -s https://www.currencydeskos.com/api/health`), then let's work
> through the 'Next 10 things' list starting at #1. Update `docs/HANDOFF.md`
> before we finish."

A fresh session also has Claude's project memory (repo layout, deploy, gotchas).
First moves: `cd server && npm test` (expect 69 passing) and skim §4 + §6 below.

## 1. What this is

CurrencyDesk OS is a multi-tenant SaaS for currency-exchange shops ("desks").
A shop signs up, gets its own isolated instance, and runs its business on it
(rate board, ledger, transfers, cheques, compliance/KYC, customer Texts). The
operator (you) runs the platform from a back-office **control panel**.

## 2. Current status — what's live and working

Deployed at **https://www.currencydeskos.com** (Render auto-deploys on push to
`main`; also reachable at `currencydesk.onrender.com`; the bare
`currencydeskos.com` 301-redirects to `www`).

Working end-to-end, in production:
- **Public site (NEW)** — the marketing site is the front door at **`/`**; the OS
  moved to **`/app`** (`/app/*` 301s back to `/app` so its root-relative assets
  resolve). It is the real Claude Design work ("More trades. Less paperwork."),
  built from the design sources in `design/site/` by `scripts/build-site.mjs`.
  The build keeps the design's own runtime (`support.js`, which resolves the
  `{{ }}` bindings) and makes each page stand alone: React vendored under
  `web/vendor/`, fonts self-hosted under `web/fonts/`, nothing fetched from a
  CDN. Verified with **every external request blocked** — 0 externals, 0
  unresolved bindings, no console errors, no horizontal overflow, desktop and
  phone. Routing is driven by `SITE_INDEX` (default `web/index.html`); drop it
  and the OS takes the root back.

  **Two designs, not one responsive page.** The desktop layout has no mobile
  breakpoints and the phone layout is a separate document, so `/` picks by
  user-agent (`Vary: User-Agent`) and both stay addressable: `/m` phone, `/d`
  desktop. Routes: `/` · `/m` · `/d` · `/faq` · `/compliance` · `/contact` ·
  `/legal` · `/signup` · `/login` · `/app`.

  **Applying ≠ opening a desk.** `/signup` is the design's Early Access
  application — eight steps ending in a Founding Operator certificate. It does
  not create anything; an accepted operator still builds their desk in the OS's
  own wizard at `/app?signup=1`. The application and the contact form both
  `POST /api/enquiries`, which stores the message (`enquiries` table) and mails
  everyone in `PLATFORM_ADMIN_EMAILS`. Both were dead ends in the design —
  they showed a made-up reference and sent nothing.

  > **To update the site:** replace the page in `design/site/` and run
  > `node scripts/build-site.mjs`. Never hand-edit `web/` — it is generated.
  > A page the design links to but hasn't delivered falls back to the matching
  > front-page section; drop the `.dc.html` in, add its `PAGES` entry, rerun,
  > and both the page and every link to it appear. Photos and fonts are
  > committed and only change on a re-export
  > (`node scripts/extract-design-assets.mjs <export.html>`).
  > **The build patches the design's runtime** in one place: `support.js`
  > forwards only `prevProps` to `componentDidUpdate`, so a page written to
  > React's contract (`prevState.step !== this.state.step`) threw on every
  > update. It now gets the logic's previous state. Anchors are asserted, so a
  > re-export that moves them fails the build rather than losing the fix.
  > **Known gaps:** the **Add-ons export is truncated** — it stops mid-document
  > with no `</x-dc>` and no logic block, so its `{{ items }}` have no data;
  > it is left out and its links fall back to `#pricing` until re-exported.
  > ~4.6 MB of design photography is served unoptimised (worth converting to
  > WebP). The phone design has no sign-in of its own, so the build injects one
  > into its footer nav (its header is full at 390px — a second action there
  > costs the wordmark). And the designed Sign In page under the design's
  > `app/` folder has not arrived, so `/login` is the OS's existing screen.
- **Signup** — the 4-phase onboarding wizard (Business → Money → Rules → Launch),
  with a real emailed verification code. A new desk is created as a real,
  isolated, server-saved instance.
- **Login** — redesigned sign-in (CurrencyDesk ID → password → **emailed 6-digit
  code** → in). Real 2FA for email-identity users.
- **Email** — transactional email is LIVE via Resend, sending from
  `noreply@mail.currencydeskos.com` (verified domain).
- **Platform admin control panel** at **`/admin`** — dark dashboard: KPIs, desk
  table with status/plan filters, detail drawer, and actions: **block/suspend,
  change plan, create a desk, and (gated) delete**. Its own 2FA login.
- **The early-access funnel (NEW)** — the public site's two forms feed
  `enquiries`, and the panel has **Early access** and **Messages** tabs that
  work them. An application carries its own progress —
  `new → reviewing → invited → accepted`, or `declined` — with operator notes,
  an audited stage change, and every answer the applicant gave.
  **`accepted` is not settable by hand**: a completed signup against the same
  address sets it and stamps the `tenantId`, which is the join that makes the
  funnel measurable rather than two unrelated lists. The nav badges count what
  is sitting unanswered.

  **Every record has its own page**, at its own URL — `/admin#/desks/<id>` and
  `/admin#/applications/<id>` — bookmarkable and reloadable, which a drawer
  never was. A desk page is the support screen: the trading picture from its
  saved book (transactions, volume, fees, clients, last trade), its **last five
  transactions**, recent activity, owner, business and regulator details, the
  team, plan and block/delete — and a link back to the application it came
  from. Moving an applicant to **invited emails them** their reference and the
  link to build the desk; the panel reports whether that email actually sent.

  **People have pages too** — `/admin#/people/<id>`, opened from the desk's
  team list. That is where support acts: **block** someone (signs them out
  everywhere at once and refuses new sign-ins, records untouched), **reset
  their password** (temporary one, every device signed out, must-change forced,
  emailed if there is an address — handed to the operator only when there is
  not), and **issue or reissue their CurrencyDesk ID**. Everything is audited.

  **The CurrencyDesk ID is real** (`server/src/auth/cdid.ts`): `CD-YORK-0042`,
  unique platform-wide, numbers running per desk and never reused, so an old ID
  in an email thread can never resolve to a different person. Sign-in accepts
  it **without a tenantId** — that is the point of it. It is issued on demand;
  accounts predating the scheme keep signing in on their staff id.
- **Per-tenant persistence** — each desk's working state is saved server-side
  (`tenant_state`), isolated per tenant.

## 3. Access

- **Admin control panel:** `https://www.currencydeskos.com/admin`
  - Login: `admin@currencydeskos.com` / `12345` (TEMPORARY — see task #1)
  - A 2FA code emails to the `admin@currencydeskos.com` Google Workspace inbox.
- **Public site:** `https://www.currencydeskos.com` — the marketing front door.
- **Demo desk (the OS itself):** `https://www.currencydeskos.com/app` — the seeded
  "York FX" desk; staff sign-in e.g. `j.masri` (password = `SEED_PASSWORD`).
- **Local dev:** `cd server && npm run dev:prototype` → http://localhost:8787.
  Tests: `cd server && npm test` (currently 69 passing).

## 4. Architecture map

- **Repo:** github.com/solzelic/Currency-desk-OS. **Work on `main`** (everything
  shipped there; the old `phase-c-wip` hold-branch is now stale/superseded).
- **Front-end (the product):** a buildless React + Babel prototype in `os-src/*.jsx`
  (all hung off `window.CDOS`), served as `CurrencyDesk OS.html`. Key files:
  `cdos-os.jsx` (shell + onboarding wizard + persistence wiring), `cdos-signin.jsx`
  (sign-in / lock / handover), `cdos-persist.js` (per-tenant save/restore).
- **Admin panel:** `admin.html` (self-contained dark React page) served at `/admin`.
- **Back-end:** Fastify + Drizzle + Postgres in `server/src`. Prod DB = **Neon**
  (`DATABASE_URL`); local = embedded PGlite (`server/.pgdata`). Routes in
  `server/src/routes/` (auth, signup, admin, tenant, tenantState, rates, staff,
  public-site). Schema in `server/src/db/schema.ts`.
- **Deploy:** `render.yaml` blueprint. Env vars in the Render dashboard:
  `DATABASE_URL`, `OXR_APP_ID`, `SEED_PASSWORD`, `RESEND_API_KEY`, `EMAIL_FROM`,
  `PLATFORM_ADMIN_EMAILS`, `PLATFORM_ADMIN_BOOTSTRAP`, `STATIC_DIR`, `STATIC_INDEX`.
- **Local secrets:** `server/.env` (gitignored; holds the real keys + the
  `PLATFORM_ADMIN_BOOTSTRAP` for local). `server/.env.example` documents them.

## 5. Built this session (commits on `main`)

Onboarding wizard; per-tenant persistence (`tenant_state`); sign-in redesign +
lock/handover; real email-verified login (2FA) + Resend; platform admin console
→ control dashboard (overview, block/plan/create/delete); suspend-not-delete
retention protocol; operator bootstrap login. Shipped in commit `444560c`.

---

## 6. Next 10 things (next session)

**Security cleanups first — these are live and sensitive:**

1. **Change the admin password & remove the bootstrap.** `12345` is a live
   placeholder. Sign in → change it (Settings/change-password), then **delete
   the `PLATFORM_ADMIN_BOOTSTRAP` env var in Render** (while set, every deploy
   resets the password back to `12345`). Consider adding a proper
   change-password UI to the admin panel.
2. **Rotate the Resend API key.** The current key passed through chat/a file. In
   Resend → API Keys, create a fresh key, update it in Render + `server/.env`,
   delete the old one.
3. **Lock down `/api/auth/login`.** The legacy password-only endpoint still
   mints a session without the 2FA code (kept for tests/back-compat) — it can
   bypass the email step. Gate or remove it so 2FA can't be skipped.

**Make new desks genuinely real (Phase C):**

4. **New desks start spotless.** The ledger/clients/settings/branches are clean,
   but Rate board, Texts, Reports, KYC, and Cheques/Transfers still show the
   York demo seed for a fresh desk (their seed logic re-fills when empty). Make
   each app's seed tenant-aware so a brand-new desk is empty everywhere.
5. **⭐ Nicer CurrencyDesk-ID scheme (OWNER PRIORITY — do early).** Replace plain
   slugs/emails as the identity with a proper human ID like `CD-YORK-0042` (the
   sign-in design already shows this format). Plan: pick the format
   (`CD-<DESKCODE>-<NNNN>`, desk code from the business, sequential number);
   generate + store it on signup (`staff_users` / a new column); accept it at
   sign-in alongside email; surface it in the admin dashboard and the sign-in
   recognition chip. Owner explicitly wants this "right away."
6. **Multi-tenant login polish.** Confirm a returning signed-up owner (a non-York
   tenant) logs in cleanly; the A4 station picker still briefly shows York's
   branches; stop the global York seed leaking into real tenants.

**Round out the platform:**

7. **Step 3 — Forgot-password flow.** `POST /api/auth/forgot` (emails a reset
   code) + `POST /api/auth/reset` (code + new password), and a "Forgot
   password?" link + flow on the sign-in screen. (Owner hit this pain already.)
8. **Admin dashboard polish.** Bulk select → bulk suspend; email a newly
   admin-created owner their temp password; pagination/virtualized table for
   scale; maybe CSV export. Also surface the retention/"kept until" date.
9. **Wire OS apps to real relational data (deeper Phase B).** Promote the JSON
   `tenant_state` snapshot toward first-class tables — ledger → the Postgres
   book, Texts inbox → `/api/quotes` — so transactions persist relationally.
10. **Billing + the store (Phase D).** Real payment for plans (Stripe), so
    "free trial → paid" works, and plan changes flow from billing rather than the
    manual admin toggle. Then a self-serve "store" for add-ons.

**Also queued (Phase E hardening):** a retention **purge job** (auto-delete data
older than 6 years, per the FINTRAC 6-year policy the owner set), rate limiting,
monitoring, and a custom-domain check for a customer desk's public site.

## 7. Gotchas / must-knows

- **Buildless prototype JSX**: `\uXXXX` escapes render literally in JSX text (use
  real chars); regex literals and incomplete ternaries inside JSX break Babel
  ("Unexpected token, expected ':'"). Fixed-position overlays inside `#os` need
  `ReactDOM.createPortal(..., document.body)` to escape the stacking context.
- **PGlite local DB**: never open `server/.pgdata` with a 2nd process while the
  dev server holds it — it corrupts the dir. Reset with `rm -rf server/.pgdata`
  (re-seeds York).
- **Real email = no code in logs.** With `RESEND_API_KEY` set, codes are sent, not
  logged (`email.ts` only logs `[email simulated]`/`[email failed]`).
- **Deletion is gated** by design: a desk must be suspended first, then a
  type-to-confirm + acknowledgement — because records must be kept 6 years.
- The platform-admin account lives in a hidden `tnt-platform` tenant, excluded
  from the desk list.
- **Do not re-introduce the "hold UI on `phase-c-wip`" model** — everything is on
  `main` and deployed now.

More detail lives in Claude's project memory and `docs/SAAS_ROADMAP.md`.
