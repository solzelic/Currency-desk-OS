# CurrencyDesk OS

The operating system for currency-exchange houses. One sign-in gives a desk its
rate board, ledger, transfers, cheques, clients/KYC, compliance filings,
till/vault cash, branches, and reports — and CurrencyDesk hosts each customer's
public storefront (live rates, converter, SMS rate quotes) on their own domain.

**Live:** https://currencydesk.onrender.com · hosted customer site at
[`/sites/yorkfx/`](https://currencydesk.onrender.com/sites/yorkfx/)

## Repository layout

| Path | What it is |
| --- | --- |
| `design/site/` | The design sources, as exported from Claude Design: one `.dc.html` per page plus the runtime they need (`support.js`, `image-slot.js`). Edit these, never `web/` |
| `web/` | The generated public site — the front door at `/`. Built by `scripts/build-site.mjs`; fully self-contained (React vendored, fonts self-hosted, no CDN). "Sign in" → `/login`, "Get early access" → `/signup` |
| `CurrencyDesk OS.html` + `os-src/` | The OS app, served at `/app` — and at `/login` and `/signup`, the two doors the site sends people through (buildless React, one `window.CDOS` global, files split by domain: `cdos-ledger.jsx`, `cdos-kyc.jsx`, …) |
| `server/` | Fastify + Drizzle backend: auth & sessions, staff administration, tenants & plans, rate boards, hosted sites, SMS rate quotes, Postgres ledger |
| `YorkFX/` | The hosted customer storefront (homepage, rates + converter, services, regulations, visit/quote) and the staff rate-board editor the OS embeds |
| `src/`, `index.html`, `vite.config.ts` | The TypeScript/Vite production rebuild track (coexists with the prototype; CI runs its typecheck, tests, and build) |
| `docs/` | Architecture, security/compliance foundation, threat model, ledger API, migration plan, product roadmap |
| `design_handoff_kyc/` | KYC design handoff: architecture, brand tokens, motion spec |
| `render.yaml` | Render Blueprint — auto-deploys `main` |

## Running locally

Backend + OS + hosted sites, one process:

```sh
cd server
npm ci
npm run dev:prototype        # http://127.0.0.1:8787
```

That serves the public site at `/`, the OS at `/app`, the customer storefront at
`/sites/yorkfx/`, and the API under `/api/*`. (Set `SITE_INDEX` to change which
file is the front door; remove it and the OS takes the root again.)

### The public site

The site is two designs, not one responsive page: the desktop layout has no
mobile breakpoints and the phone layout is its own document, so `/` picks by
user-agent and both stay addressable — `/m` for the phone design, `/d` for the
desktop one.

| Route | What it serves |
| --- | --- |
| `/` | the desktop design, or the phone design to a phone (`Vary: User-Agent`) |
| `/m` · `/d` | either layout, directly |
| `/faq` · `/compliance` · `/contact` · `/legal` | the standalone pages |
| `/signup` | the Early Access application |
| `/login` | the OS sign-in |
| `/app` | the OS (`?signup=1` opens the new-desk wizard) |

Applying and opening a desk are two different things: `/signup` takes an
application, and an accepted operator creates their desk from the OS's own
wizard. The Early Access and contact forms both `POST /api/enquiries`, which
records the message and emails everyone in `PLATFORM_ADMIN_EMAILS`.

To change the site, edit or replace a page in `design/site/` and rebuild:

```sh
node scripts/build-site.mjs
```

Never hand-edit `web/` — it is generated. Pages the design links to but has not
delivered yet fall back to the matching section of the front page; drop the
`.dc.html` into `design/site/`, add its entry to `PAGES` in the build script,
and rerun — both the page and every link to it appear. Photographs,
illustrations and web fonts are committed under `web/` and only change when the
designer re-exports — `node scripts/extract-design-assets.mjs <export.html>`
refreshes them.
Locally the database is embedded (PGlite, `server/.pgdata`) and
the seeded owner sign-in is `j.masri` / `yorkville`. In production, passwords
are per-employee and managed inside the OS (Settings → Employees).

Server tests and typecheck:

```sh
cd server
npm test
npm run typecheck
```

Vite app (production rebuild track):

```sh
npm ci
npm run dev
npm run check
```

## Architecture in one paragraph

The tenant is the unit of everything: staff sign in with per-employee
credentials (scrypt hashes, opaque session cookies, append-only audit trail);
the purchased **plan** (basic/pro/premium) gates which apps the OS unlocks and
which APIs the server serves; the desk publishes a **rate board** the whole
system prices from — the OS, the public site's currency board and converter,
and SMS rate-hold quotes all read the same publication. Hosted sites serve at
`/sites/<slug>` and, once a customer points DNS here, on their own domain via
Host-header routing — no code change per customer.

## Deployment

Push to `main` → Render auto-deploys (`render.yaml`). One-time environment in
the Render dashboard:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string |
| `OXR_APP_ID` | openexchangerates.org App ID (hourly market rates) |
| `SEED_PASSWORD` | First-boot bootstrap password for a brand-new database only |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | Set these and SMS quotes send for real; unset, the flow runs in simulated mode |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional. For A2P 10DLC, set this (`MG…`) to send through a campaign-linked Messaging Service; it takes precedence over `TWILIO_FROM` |
| `TWILIO_WHATSAPP_FROM` | Optional. Set to a WhatsApp sender (e.g. `whatsapp:+14155238886`, the Twilio sandbox) to deliver quotes over WhatsApp instead of SMS; takes precedence over the SMS senders |
| `RESET_STAFF_PASSWORD` | Break-glass only (`staffId:newpassword`), remove after use |

Custom domains: record the customer's domain in the OS (Settings → Business
profile → Your public site), have them point DNS (CNAME/ALIAS) at this service,
and add the domain under Render → Custom Domains so TLS is issued.

> **Security status:** the OS front end still persists demo desk data in
> browser storage; do not store real KYC documents or production financial data
> in it. Credentials, sessions, tenancy, rates, quotes, and the ledger are
> server-side. See [docs/SECURITY_COMPLIANCE_FOUNDATION.md](docs/SECURITY_COMPLIANCE_FOUNDATION.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security and compliance foundation](docs/SECURITY_COMPLIANCE_FOUNDATION.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Development](docs/DEVELOPMENT.md)
- [Ledger posting API](docs/LEDGER_POSTING_API.md) · [invariants](docs/LEDGER_POSTING_INVARIANTS.md)
- [Migration plan](docs/MIGRATION.md)
- [Product roadmap](<docs/CurrencyDesk OS - Roadmap v2.html>)
- [KYC developer handoff](design_handoff_kyc/README.md)
