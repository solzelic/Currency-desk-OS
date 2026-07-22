# CurrencyDesk OS — Session Handoff

_Last updated: 2026-07-22. Status: **LIVE on the web.**_

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
- **Per-tenant persistence** — each desk's working state is saved server-side
  (`tenant_state`), isolated per tenant.

## 3. Access

- **Admin control panel:** `https://www.currencydeskos.com/admin`
  - Login: `admin@currencydeskos.com` / `12345` (TEMPORARY — see task #1)
  - A 2FA code emails to the `admin@currencydeskos.com` Google Workspace inbox.
- **Demo desk (the OS itself):** `https://www.currencydeskos.com` — the seeded
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
5. **Nicer CurrencyDesk-ID scheme.** Replace plain slugs/emails as the identity
   with a proper ID like `CD-YORK-0042` (per the sign-in design). Owner asked
   for "better than numbers." Decide the scheme, generate on signup, show it in
   admin + sign-in.
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
