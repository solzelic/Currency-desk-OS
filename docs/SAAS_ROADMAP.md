# CurrencyDesk — Multi-tenant SaaS build plan

The plan to turn CurrencyDesk from a single seeded demo into a real product
where an exchange shop **signs up, gets a brand-new empty instance, and runs
their business on it** — with data that's live, server-side, and isolated per
tenant.

---

## North star (definition of done)

1. A new shop goes to a signup page, creates an account, and gets their **own
   blank tenant** — their site, their staff, their rates, nothing pre-filled.
2. They and their staff **log in** and the OS is theirs; nothing leaks between
   tenants.
3. Everything operational — the ledger book, clients/KYC, till counts, the
   Texts inbox, settings, roster — is **stored on the server**, survives a
   browser wipe, and is the same on every terminal.
4. Billing is real: a plan is a paid subscription.

## Current state (honest inventory)

**Already server-side (Fastify + Drizzle + Postgres):** tenants (plan, site
slug/domain/config), legal entities, branches, workspaces, per-employee auth
+ sessions, staff admin, rate boards + market rates, SMS rate quotes, a
Postgres ledger (`/api/ledger/*`), audit events.

**Still browser-local (`localStorage`, per-device — the gap):** the OS Ledger
app's book, clients/KYC, till/vault counts, cheques, transfers, branches/tills
detail, the Texts app inbox + threads, and most of `settings`. The backend has
foundations; the **front-end apps mostly aren't wired to them.**

**Hardcoded:** one tenant (`tnt-yorkfx`), seeded on boot. No signup, no way to
create a second shop.

---

## Key architectural decisions (resolve these first)

### D1 — How does login know which tenant? **→ recommend: workspace slug + email**
Options: (a) subdomain `yorkfx.currencydesk.app` (clean, needs wildcard DNS +
routing), (b) workspace slug typed at login, (c) email is globally unique →
resolves tenant. **Recommendation:** each tenant already has a `site_slug`;
serve the OS per-tenant (`/app/<slug>` or their custom domain) and make **email
the login identity** (unique per tenant), so staff log in with email + password
and the tenant comes from the URL. Keeps the door simple, no DNS magic to ship
v1. Subdomains can come later.

### D2 — How is operational data stored? **→ recommend: hybrid**
- **Relational tables** for money & compliance data — ledger, clients/KYC,
  quotes, till/vault, cheques, transfers. These must be queryable, auditable,
  and are the system of record. (The Postgres ledger already is.)
- **Per-tenant JSON store** (one `tenant_state` table, keyed by the existing
  `cdos_*` keys) for settings, UI config, roster prefs, Texts templates —
  things that are just "the shop's configuration." This lets us swap the
  front-end's `localStorage.get/set` for server calls with minimal rewrite.

Rationale: don't rebuild 26 localStorage domains as relational tables; only the
ones that need it. Fastest path to "data is live everywhere" without
over-engineering config.

### D3 — What does "the store" mean? **→ needs your answer**
(a) a public signup site where shops onboard themselves, or (b) listing
CurrencyDesk as a product somewhere. This plan assumes **(a)** — self-serve
signup — as the finish line. Confirm.

---

## The plan, in phases (dependency order)

### Phase A — Auth, signup & instance creation  *(the foundation)*
**Goal:** anyone can create a brand-new empty tenant and log into it; tenants
are fully isolated.

Server:
- `POST /api/signup` → creates tenant (plan `trial`), legal entity, one branch
  + till, an **administrator** owner user (email + password, scrypt), a unique
  `site_slug`; returns a session (auto-login). Validates slug/email uniqueness,
  password strength; audited. **[M]**
- Make **email the login identity** (unique per tenant); `POST /api/auth/login`
  resolves tenant from the request context (slug/host), not the hardcoded
  default. **[M]**
- Stop auto-seeding York FX on every boot; the York FX demo becomes *one seeded
  tenant*, not the global default. New tenants start empty. **[S]**
- Enforce `tenantId` on **every** existing data route (audit the queries).
  **[M]**

Front-end:
- Public **signup page** (business name, owner name, email, password, desired
  slug) → creates the instance → lands in the fresh OS. **[M]**
- Login page resolves the tenant from the URL (`/app/<slug>` or custom domain).
  **[S]**

**Acceptance:** sign up "Maple FX" → get an empty OS at its own slug → its
staff log in → York FX data is nowhere in sight.

### Phase B — Make the data live (server persistence)  *(the bulk)*
**Goal:** operational data lives on the server, scoped per tenant, same on
every terminal, survives a wipe.

Server:
- `tenant_state` JSON store: `GET/PUT /api/state/:key` (per tenant, per key),
  for settings/config/roster/Texts-templates. **[M]**
- Wire the **OS Ledger** app to the existing Postgres ledger — post/read deals
  server-side (this is roadmap #1, the biggest single win). **[L]**
- Clients/KYC: table + `/api/clients` CRUD, tenant-scoped. **[L]**
- Till/vault counts, cheques, transfers: tables + APIs (can be staged). **[L]**
- **Texts inbox → live**: back the Texts app with `rate_quotes` + a
  `quote_messages` thread table; wire the app and the New-Transaction ref
  redemption to `/api/quotes` instead of localStorage. **[M]** *(this also
  closes the demo↔real seam we keep hitting)*

Front-end:
- Swap each app's `localStorage` data layer for the server (a small
  `cdosStore` shim: read-through cache + server write). Do it app by app:
  Ledger → Texts → Clients → Settings → Till/Vault/Cheques/Transfers. **[L]**

**Acceptance:** post a deal on terminal A, see it on terminal B; clear the
browser, the book is still there; a real website text lands in the Texts inbox
and redeems at the counter.

### Phase C — First-run reality  *(new tenants feel like theirs)*
**Goal:** a new tenant opens empty and the owner sets it up; only the demo
tenant is pre-filled.

- First-run detection (no board, no staff beyond owner, no deals). **[S]**
- Wire the existing **setup wizard** (roadmap #3): business info, locations,
  floats, staff, currencies → seeds *their* instance. **[M]**
- True empty states across apps (no "York FX" placeholders). **[M]**

**Acceptance:** fresh Maple FX opens to a setup wizard, not a fake York FX.

### Phase D — Billing & the store  *(sell it)*
**Goal:** a plan is a real paid subscription; shops self-serve onboard.

- **Stripe**: checkout on signup/upgrade, webhook → set `tenants.plan`, trial
  → paid, dunning. **[L]**
- Public **marketing + signup site** (the "store"): pricing, sign up, land in a
  trial instance. **[M]**
- Wire the existing in-OS plan cards to real Stripe state. **[S]**

**Acceptance:** a shop signs up, pays, and their plan/entitlements are real.

### Phase E — Production hardening  *(regulated-buyer trust)*
- Real 2FA (SMS via the Twilio work) **or** an honest per-tenant toggle (kill
  the fake `000000`). **[M]**
- Cross-tab/session sync, versioned migrations for the JSON store, export &
  backup. **[M]**
- FINTRAC submission pipe, maker-checker approvals, retention. **[L]** *(later)*
- SMS delivery: finish Twilio A2P (external review; sole-prop brand currently
  mock — needs a real brand or the Canada path). **[external]**

---

## Recommended sequence

**A → B(Ledger + Texts first) → C → D → E.**

Phase A makes instances real. Phase B (starting with the Ledger and the Texts
bridge) turns the demo into a system of record. C makes new shops feel bought,
not borrowed. D lets you actually sell. E is the trust layer for scale and
regulators.

Fastest path to "York FX is live on it for real": **A + B(Ledger, Texts) + C.**
Fastest path to "put it in the store": **+ D.**

## Effort key
S ≈ hours · M ≈ a day · L ≈ multiple days · XL ≈ a week+. Phase B is the
heaviest because it's many apps; it can ship app-by-app so value lands
incrementally.
