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
| `CurrencyDesk OS.html` + `os-src/` | The OS app, served at `/app` and `/login` (buildless React, one `window.CDOS` global, files split by domain: `cdos-ledger.jsx`, `cdos-kyc.jsx`, …). `/signup` is the Early Access application (`web/early-access.html`), not the OS |
| `server/` | Fastify + Drizzle backend: auth & sessions, staff administration, tenants & plans, rate boards, hosted sites, SMS rate quotes, Postgres ledger |
| `YorkFX/` | The hosted customer storefront (homepage, rates + converter, services, regulations, visit/quote) and the staff rate-board editor the OS embeds |
| `docs/` | The durable set: `PROJECT_STATE.md` (what is true now), `REPOSITORY_MAP.md` (what runs, where, how it builds), architecture, security, and the financial-invariant docs |
| `design/kyc-handoff/` | KYC design handoff: architecture, brand tokens, motion spec, verification-states reference |
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

One console note is deliberate: the front page's preload scanner fetches
`{{ p.src }}` literally before the design's runtime substitutes the real
image path a tick later. Silencing it means renaming attributes in the
design's markup and copying them back after resolution — a real risk to the
front page's imagery in exchange for one console line. Left on purpose.
(The `401` from `/api/auth/me` on `/app` and `/login` is a signed-out
visitor asking whether they are signed in, and being told no.)

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

> **Security status:** the financial ledger, credentials, sessions, tenancy,
> rates, quotes, client records and ID documents are server-side — one book,
> and it is the server's (see
> [docs/CASH_OWNERSHIP_INVARIANTS.md](docs/CASH_OWNERSHIP_INVARIANTS.md) and
> [docs/CLIENT_RECORDS.md](docs/CLIENT_RECORDS.md)). Desk preferences and
> screen state still sync as a versioned JSON document. Known open risks are
> tracked as issues and listed in
> [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md).

## Documentation

Start here: [PROJECT_STATE](docs/PROJECT_STATE.md) — what is true now ·
[REPOSITORY_MAP](docs/REPOSITORY_MAP.md) — what runs, where it lives, how it
builds · [AGENTS.md](AGENTS.md) — the working rules.

- [Architecture](docs/ARCHITECTURE.md) — the governing document
- [Development](docs/DEVELOPMENT.md) · [Migrations](docs/MIGRATION.md) · [Email](docs/EMAIL.md)
- [Road to deployment](docs/ROAD_TO_DEPLOYMENT.md) — readiness scoring
- Financial invariants: [cash ownership](docs/CASH_OWNERSHIP_INVARIANTS.md) · [absent figures](docs/ABSENT_FIGURES.md) · [cost basis](docs/COST_BASIS.md) · [cheques](docs/CHEQUE_CASHING.md) · [obligations](docs/OBLIGATION_LINES.md) · [thresholds](docs/DESK_THRESHOLDS.md) · [currencies](docs/DESK_CURRENCIES.md) · [documents](docs/GENERATED_DOCUMENTS.md) · [client records](docs/CLIENT_RECORDS.md) · [jurisdiction packs](docs/JURISDICTION_PACK_ARCHITECTURE.md)
- Ledger & quotes API: [posting](docs/LEDGER_POSTING_API.md) · [posting invariants](docs/LEDGER_POSTING_INVARIANTS.md) · [quotes](docs/QUOTE_SERVICE.md) · [quote invariants](docs/QUOTE_INVARIANTS.md)
- [Security & compliance](docs/SECURITY_COMPLIANCE_FOUNDATION.md) · [Threat model](docs/THREAT_MODEL.md)
- [Growth pipeline](docs/GROWTH_PIPELINE.md) · [Onboarding](docs/ONBOARDING.md) · [Stripe billing](docs/STRIPE_BILLING.md)
- [KYC design handoff](design/kyc-handoff/README.md)
