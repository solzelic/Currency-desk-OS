# PROJECT_STATE — what is true now

This document describes the present. It is not a changelog (git history and
PRs are the changelog) and not a roadmap essay. Every PR either updates it or
explicitly records that it was reviewed and needed no change — CI enforces
this (`scripts/check-repository-governance.mjs`).

## What CurrencyDesk is today

A multi-tenant SaaS operating system for currency-exchange houses. One
sign-in gives a desk its rate board, ledger, quotes, transfers, cheque
cashing, clients/KYC, compliance thresholds, alerts and filing records
(a filing is sealed and recorded in the ledger; submission to the regulator
is not automated), till/vault cash, and reports. CurrencyDesk also hosts
each customer's public storefront (live rates, converter, SMS rate quotes)
on their own domain, and runs a growth pipeline (lead research + outbound
calling) for its own sales funnel.
Deployed as **one Render web service** (`render.yaml`), auto-deploying `main`.

## Current product milestone — Shop-Ready Core v1

One shop, one full operating loop, provable end to end: an approved operator
can go from Early Access → approval → onboarding → configured desk and rates
→ open till → quote and post FX transactions → acknowledge manual KYC
verification when the system flags it → receive internal compliance
alerts/work items → have the authoritative ledger, till and audit trail
update correctly → reconcile and close the day.

Automated KYC-provider integration, SMS delivery, calling-agent automation,
external rate publishing and other external integrations are useful next
layers — they are not blockers for proving this core loop.

## Current architecture (major components only)

- **Server** — Fastify + Drizzle, `server/src/`. API plus all static serving
  from the repo root behind an allow-list. Embedded PGlite in dev/test,
  Postgres in production; boot applies DDL + checksummed migrations.
- **The ledger** — server-side Postgres, `server/src/ledger/` + migrations.
  Append-only; the single authoritative book.
- **The OS** — buildless React in `os-src/` + shell `CurrencyDesk OS.html`,
  compiled ahead of time to `web/app/` by `scripts/build-os.mjs`.
  Production `/login` and `/app` serve that compiled shell
  (`/web/app/os.js`). `STATIC_INDEX` names the uncompiled shell as a
  fallback only; it does not override compiled output.
- **Admin panel** — `admin.html`, compiled to `web/app/admin.*`.
- **Marketing site** — generated into `web/` from `design/site/*.dc.html`.
- **Onboarding** — `web/onboarding.html`, generated from
  `design/onboarding/currencydesk-onboarding.html`.
- **Customer storefront** — `YorkFX/`, served at `/sites/yorkfx` and via
  customer domains. Customer pages are plain HTML and their own scripts;
  they do not load unpkg, Babel, or `react.development`. The design-time
  tweaks panel stays in the repo and is not referenced from those pages.

Full map, routes and build commands: `docs/REPOSITORY_MAP.md`.

## What is authoritative (where truth lives)

| Concern | Authority |
| --- | --- |
| Financial ledger — every balance, movement, P&L | Server Postgres ledger (`server/src/ledger/`). One book. The browser renders cash, never computes it |
| Customers / KYC files | Server: `desk_clients` (+ documents/images tables). `ledger_customers` is the ledger-side counterparty record — deliberately distinct |
| Published rate board | Server (`/api/rates`, publish cycle). `localStorage` on the storefront is a cache, never a second book |
| Tenant / session identity | Server sessions + CD-IDs; the server mints all identifiers |
| Frontend truth | Sources: `os-src/`, `design/` (site, onboarding, emails), the root shells. `web/` and `web/app/` are generated output — never edited directly, CI-gated for staleness |

## Production/build surfaces

`marketing site` (`/`) · `OS` (`/app`, `/login`) · `admin` (`/admin`) ·
`onboarding` (`/onboarding/:code`) · `customer storefront` (`/sites/yorkfx`)
· `server/API` (`/api/*`).

## Current active work

- Receipts print from the posted deal. Owner options (paper size, which lines, logo, header and footer) live on `tenants.receipt_settings` (migration 035), not in the tenant state blob, because any teller can write that blob. Browser print is the default. The printer screen lists four short steps and the paths this desk is built for: Epson TM-T20III and TM-m30 by USB or the print dialog, Star TSP100 in ESC/POS mode, the print dialog for a printer already installed, and AirPrint on iPhone and iPad. Direct classic Bluetooth and TCP 9100 are not offered. It does not claim every printer. Chrome and Edge can also send ESC/POS over USB, serial, or Bluetooth Low Energy; the paired printer stays on the device (`local_printer_v1`) and is not synced. Safari uses AirPrint.  Email uses the existing Resend sender when `RESEND_API_KEY` and `EMAIL_FROM` are set, and the button stays hidden when they are not. The closing line is the existing receipt footer (`receiptClosing` in `os-src/cdos-receipt.js`). There is no per-currency greeting in the product.
- The compiled-OS production slice is closed on `main` (`90a3890`, #43).
  Live `/login` and `/app` serve `/web/app/os.js`. Re-verified 2026-08-17
  at `f31cf21` (#44).
- **Engineering standards audit** of `main` at `f31cf21` is recorded in
  `docs/STANDARDS_AUDIT.md` (2026-09-04). Docs only — no product slice
  opened at that stamp. Issue **#31** (one-shot platform-admin bootstrap)
  has since landed in code. Audit Slice D (honest public health) has
  also landed: `GET /api/health` now performs a trivial database read.
  Audit Slice E (quote door matches the book) has landed:
  `POST /api/quotes` validates currency as an uppercase ISO-style
  3-letter code, not a four-way CAD/USD/EUR/GBP enum. A desk that can
  float PHP can quote it. Pack pair rules and `assertTradeable` are
  unchanged.
  Audit Slice F (storefront holds are decimal) has landed:
  `rate_quotes` amounts/rates and `rate_boards` margins are
  `numeric` (money 2dp, rates/margins 12dp). The SMS quote path and
  the public board display price with `decimal.js`, once. jsonb board
  mids remain JS numbers — parked with the rest of that audit finding.
  Audit Slice B (platform MFA) has landed: a platform-operator sign-in
  at `/admin` requires TOTP after enrollment. The first sign-in enrolls
  (otpauth URI shown once, backup codes stored only as scrypt hashes).
  Desk `/login` is still password-only.

- **Signup mobile on the admin call** — the number `placeOutboundCall`
  dials is `enquiries.details.phone`. The mobile typed while opening a
  desk lives on `tenants.setup`. When a Canada desk signs up or launches
  and that enquiry phone is empty, the setup mobile is copied onto it
  (local +1, ten digits — the shape the early-access form already
  stores). A number already there is left alone. Signup and launch do
  not dial. The applications list in admin shows that the mobile is on
  the call path; the same shop record is where the call is placed, and
  where the confirmation and transcript appear. A recording URL is not
  stored or shown. Empty transcript until the provider sends one.
  Existing gates are unchanged: admin trigger, kill switch, consent,
  research review, hours.

- **European Union desks can open on the 2027 AMLR pack.**
  `pack-eu-v2` ("EU AMLR 2027") follows Regulation (EU) 2024/1624,
  which applies from 10 July 2027. Cash of at least 3,000 EUR needs
  identification. An occasional transaction of at least 10,000 EUR,
  and a transfer of funds of at least 1,000 EUR, need customer due
  diligence. Suspicious activity goes to the national financial
  intelligence unit at any amount. There is no EU large-cash report.
  Records are kept 5 years. Until 10 July 2027 the desk shows that
  these are the 2027 rules and that current national law still
  governs. `pack-eu-v1` is not edited. A desk already on it stays
  there until the owner opts in. New European Union signups open on
  version 2, in euros. Non-euro member states are a later local
  layer. Detail, sources, and the gaps: `docs/EU_AMLR_PACK.md`.

- **Australia opens on pack-au-v2.** A new Australian desk is given
  `pack-au-v2`. A desk already on `pack-au-v1` stays there until an
  owner opts in (`POST /api/ledger/jurisdiction-pack/au-v2`). Opt-in
  does not rewrite posted deals and does not clear the desk's own
  identification number. Currency exchange is customer due diligence
  at or above A$1,000 (Act s.39E items 9 and 10). Remittance and
  electronic transfer are every deal. A threshold transaction is
  physical currency of A$10,000 or more received or paid, one
  transaction, due in 10 business days. Suspicious matters are 24
  hours for terrorism financing and 3 business days otherwise. The
  international value transfer report (IVTS, formerly IFTI) is in the
  catalogue. Records stay 7 years. The annual compliance report is
  listed and not prepared by the till. Filing to AUSTRAC is not
  automated. Detail, sources, and gaps: `docs/AUSTRALIA_PACK.md`.

- **Country rules packs can hold the rule as written.** A pack stores
  an identification line for each of foreign exchange, remittance,
  electronic funds transfer, and virtual currency. Null on that line
  means the kind of deal has no line; zero means every deal of that
  kind. Each line also stores whether the amount is "at or above" or
  "more than", a due-diligence level (identify, customer due diligence,
  or enhanced), and whether it applies to cash only. A report row stores
  a filing deadline (immediately, a count of hours, before the deal is
  carried out, by a day of the next month, or a count of calendar or
  business days), how deals are added together (a fixed 24-hour window,
  a calendar month, a rolling number of days, one banking day, or not
  at all), whether the threshold is "at or above" or "more than", which
  direction of cash it covers, whether it counts cash only, and the
  currency the threshold is written in. A baseline threshold written
  in US dollars is converted at the newest market snapshot. The six
  country packs seeded before Serbia still state their thresholds in
  home currency, with the new fields at their defaults, and they keep
  the numbers they had. Serbia is a seventh country pack
  (`pack-rs-v1`): the lines are written in euros and the book is
  dinars. Those euro lines convert at the NBS middle rate for the
  Belgrade day, from `nbs_middle_rates`, and not at the market
  snapshot. A country
  with no pack is not given Canada's, and it is not paused. It
  operates under `pack-intl-v1`, an international baseline that is not
  a country. A signup that names Canada and leaves home currency blank
  still opens on the Canada pack and a CAD rate board, so the first
  quote can be priced. A baseline desk that names a home currency keeps
  it. One that names none keeps its books in USD and opens a USD rate
  board. The baseline identifies a cash foreign exchange at 3,000 USD
  or more, and a remittance, electronic transfer, or virtual-currency
  deal at 1,000 USD or more. Full due diligence and the large-cash
  record are 10,000 USD or more in a fixed 24-hour window. That record
  is internal; the desk checks whether its own authority wants a
  report. A suspicious transaction has no amount and is due
  immediately, to the country's financial intelligence unit. Terrorist
  or sanctioned property stops the deal and is reported immediately.
  No sanctions list ships with the pack. Records are kept five years.
  The regulator field is empty. USD lines convert to the desk's home
  currency at the newest market snapshot (CAD per 1 unit, the same
  source the rate sync stores), rounded down to the cent, and that
  rate and its timestamp are written on the deal.   The same conversion
  is what the till reads for the identification line and the large-cash
  line, and what the transfer form reads for the remittance line
  (1,000 USD). The shop's board mid is not used. A missing snapshot, one
  older than 24 hours, or a missing mid leaves those lines
  unset, so identification and the purpose and source of funds are
  required on every deal. When the line is already in the home
  currency, no snapshot is required. The till and Settings say "We
  don't have rules for your country yet. These are the international
  anti-money-laundering rules. Please check they match your country's
  laws." Compliance names the pack International baseline (FATF),
  names no regulator (the country's financial intelligence unit), and
  lists Large cash record (CASH-RECORD), Suspicious transaction
  (SUSPICIOUS), and Terrorist or sanctioned property
  (SANCTIONS-STOP). Each money line is a plain sentence. A desk
  following the baseline reads the converted home amount and the
  US-dollar figure it came from. A stricter line names the desk's
  own figure and the converted baseline separately; the US-dollar
  source sits on that converted pack value, not on the owner's
  lower number. A looser line names the same converted baseline.
  A missing or stale rate says identification is required on every
  deal. The screen does not fill a baseline desk in with Canada,
  FINTRAC, or the unconverted 3,000 and 10,000. The new-transfer
  form treats the typed amount as the desk's home currency. A send
  is that amount plus the fee; a receive is the payout. The binding
  line is the lower of the remittance line and the desk's own
  identification line. No line, or no fresh rate, means identification
  is required. A desk already on the Canada pack version 1 still
  identifies at that pack's single line, in Canadian dollars. A new
  Canada desk opens on version 2. See docs/CANADA_PACK.md.
  The threshold editors stay available. A void, a cheque
  clearance or return, and an obligation settlement or write-off still
  post, and they keep the pack the original deal was stamped with.
  Vault and till cash movements still post. Migration 028 points a
  CAD, empty, or null home currency at the Canada pack and stores CAD
  where it was blank. Every other home currency is pointed at the
  baseline and keeps its currency. The known-wrong country packs are
  not assigned by that backfill.

- **Canada pack version 2 (`pack-ca-v2`).** New Canada desks open on
  it. A desk already on `pack-ca-v1`, including the York seed, stays
  there until an owner opts in from Compliance, on the Jurisdiction
  tab. The move is one way. It does not rewrite posted deals and it
  does not change the desk's own identification number. Version 2
  identifies a foreign exchange and a money order at CAD 3,000, and a
  remittance, an electronic funds transfer, or virtual currency at
  CAD 1,000. A looser desk number can replace the 3,000 lines. It
  cannot raise the 1,000 lines. A large cash report is cash received,
  due within 15 calendar days. The 24-hour total includes every
  amount, on three axes that are not mixed: conducted by, on behalf
  of, and for the benefit of. Identity is also required when that
  total reaches CAD 10,000, including a receipt that is under the
  identification line on its own. An electronic funds transfer report
  and a large virtual currency report are due within 5 working days.
  The listed person or entity property report is immediate. It is
  property of a listed person or a terrorist group, not a country
  sanctions stop. At a foreign exchange of CAD 3,000 or more the
  ticket needs the customer's name, address, occupation, and date of
  birth. A remittance at CAD 1,000 or more stores the beneficiary's
  name and address on the ledger. The counter does not book virtual
  currency. Ministerial directives stay a free-text note. A full
  compliance program, a politically exposed person check at an
  electronic transfer of CAD 100,000, and a business relationship on
  the second verification are not in this pack. Working days are
  Monday to Friday. Statutory holidays are not skipped. Citations,
  the opt-in, and those gaps are in docs/CANADA_PACK.md.

- **Serbia (`pack-rs-v1`).** The first Serbia pack. An authorised
  exchange office (Article 4(1)(2) of the anti-money-laundering law).
  The National Bank of Serbia supervises those offices (Article 109).
  APML is the financial intelligence unit. A new desk that picks
  Serbia opens on this pack, in dinars, regulator shown as NBS / APML.
  A desk already open is not moved. Exchange identification is 5,000
  EUR or more, before the deal (Articles 8(2) and 10). A transfer is
  more than 1,000 EUR (Article 8(1)(3)). Virtual currency uses the
  general occasional line, 15,000 EUR or more. Cash of 15,000 EUR or
  more is reported to APML immediately and at latest within 3 days,
  and is not added to other deals (Article 47(1)). A suspicion report
  is due before the deal (Article 47(2)). The teller can stop the
  attempt. The desk saves a draft and an audit row, and does not post.
  It does not send the draft to APML, and it does not spot suspicion
  on its own. A later attempt without the stop can still post. Euro
  amounts convert at the NBS official middle rate for the Belgrade
  calendar day, from `nbs_middle_rates`, rounded down to the cent.
  The desk does not read `market_rates` for that conversion and does
  not fetch the bank. No row for that day refuses an unidentified
  customer and does not claim the euro line was met. The deal stores
  `nbs_middle` or `none`, the rate, and when the row was stored. A sale of 50 or 100 US dollar notes records the
  customer's name, JMBG or passport number, and the serial number of
  each note. A counter marked airside or inside a casino requires
  that name and number on every cash buy and sell. Records are kept
  five years (Article 95). The pack does not delete them and does not
  add the extra five years an authority can order. Migration 033.
  029 and 031 are already on main. 027 and 030 are still open drafts,
  so 033 stays the next free number. Sources, the article table, and
  the gaps: `docs/SERBIA_PACK.md`.

- **First-run tour** — the first time someone reaches the desk, a
  skippable walk-through points at the real screens. The tour does not
  open or raise a window. A step runs only when that window is already
  open and in front; until then the card offers a button (Open the till,
  Open the dashboard) and only that click opens it. The card sits in a
  gap so the shop figures, the drawer, the count, and the file list stay
  readable. Skip and Open sit off the desk's own controls, and the card
  moves if one appears underneath them (a sealed-copy button, for
  example). Skip stays on the card. An owner is shown the shop,
  then clients, then the file folder on a customer record (identification
  standing, the papers filed there, and search). Anyone else is shown the
  cash drawer: the till, then the count — and only if that app is on their
  dock. Reconcile and close is not a step: that panel is the close, and
  with no count saved it shows an error. The tour does not count, post,
  or close cash. A step whose screen is not there is left out; the tour
  does not add a screen, a dock icon, or a second dashboard. Skip or
  finish is stored per person in the desk preference document
  (`cdos_tour_v1`), the same save that keeps the rest of the desk across
  a refresh. It does not file a paper and does not change identification
  standing.

- **Product-demo desk** — York FX can be opened as a lived-in shop for a
  meeting. Staff id `demo` is created on that tenant if missing; the
  password is stamped only from `DEMO_STAFF_BOOTSTRAP` and is never
  overwritten on a later boot. `DEMO_POPULATE=1` posts a small already-
  saved history through the real quote / ledger / client-record
  services (CAD↔USD/EUR), only when `tnt-yorkfx` still has
  `siteSlug=yorkfx`. Login is `/login` → `/app`, not `/admin`. How to
  run it: `docs/DEMO_DESK.md`.

- **PR #30** — caller-safe lead dossier (growth pipeline). Still open.
  Not merge-ready: conflicts with `main` (`docs/HANDOFF_GROWTH_PIPELINE.md`
  was deleted in #40), and its CI is from 2026-08-06 (pre-governance).
  Outside the locked compiled-OS slice. The audit recommends park/close.

The Phase 1 repository cleanup is complete: governance, the security
cherry-pick, deterministic deletions, and documentation consolidation have
all landed. The nine unreferenced YorkFX media files rated LOW-MED were
deliberately retained until external hot-linking can be ruled out.

## Known high-priority engineering risks (unresolved)

1. **Resend API key rotation** (issue #32) — the key passed through chat;
   rotation cannot be verified from the repo. Open until confirmed rotated.

Issue **#34** (multi-till/workspace resolution) is closed in code: an
unscoped ledger, quote or client-records call uses the workspace stamped
on the session (first till at the user's home branch at sign-in; updated
by `POST /api/ledger/till-selection`). `x-workspace-id` still names a
till for that request and is SCOPE_DENIED when out of scope. Adding a
till no longer denies existing callers. The day-at-the-desk seam spec
trades on its own till and no longer needs a `zz-` filename prefix.

Issue **#31** (`PLATFORM_ADMIN_BOOTSTRAP` re-set the operator password on
every boot) is closed in code: `ensurePlatformAdmin` creates a missing
account and never overwrites `passwordHash` / `mustChangePassword` /
`passwordUpdatedAt`. The env var should still be removed from Render after
first sign-in so the plaintext is not left in the host environment.

Public `GET /api/health` is no longer process-alive only. It runs the same
kind of trivial tenant read as the admin dashboard's database check
(`server/src/platform/health.ts`) and answers **503** `{ ok: false,
error: "database" }` when that read fails. Render `healthCheckPath` still
points at `/api/health`. Free-tier sleep after idle is unchanged — that
is a hosting step, not this probe. `/api/admin/health` remains the
authenticated narrative dashboard.

## Next engineering priorities (ordered)

1. The Shop-Ready Core walkthrough — prove the milestone loop end to end.
   The operator file folder is no longer the gap in that loop: opening a
   client shows the papers filed for them, searchable, from the database,
   and where they stand (`unverified` / `identified` / `expired` /
   `verified`). The identification and large-cash lines stay the pack's.
   The platform desk tile counts those customers and that standing from
   `desk_clients`, not from the browser blob.

## Last reviewed

**2026-10-07**, Australia pack v2. New Australian desks open on
`pack-au-v2`. Desks on `pack-au-v1` stay until they opt in, and a
posted deal keeps its stamp. The foreign-exchange identification line
stays A$1,000 because Act s.39E items 9 and 10 exempt initial customer
due diligence below that for a cash bureau. It is not a zero line.
Remittance is every deal. The threshold transaction report counts cash
received or paid and does not add transactions together. The website
names IVTS, not IFTI. `docs/AUSTRALIA_PACK.md`.

**2026-10-07**, Serbia pack `pack-rs-v1`. New desks that pick Serbia
open on it, in dinars. Euro thresholds convert at the NBS middle rate
for the Belgrade day. A missing rate, or a rate for another day,
refuses an unidentified customer and does not use the market snapshot.
A teller can stop a suspicious attempt and save a draft. The desk does
not send it. Existing desks are not moved. The public pages list Serbia
as Available, not Live, and the euro identification lines as Assisted.
Detail is `docs/SERBIA_PACK.md`.

**2026-10-07**, EU AMLR 2027. New European Union desks open on
`pack-eu-v2`. Cash identification is 3,000 EUR. Full customer due
diligence is 10,000 EUR for an occasional transaction, and 1,000 EUR
for a transfer of funds. There is no EU large-cash report. The
suspicious-transaction report has no amount. The pack applies from
10 July 2027, and the desk says so until that date. `pack-eu-v1`
is unchanged. An owner on version 1 can opt in. The desk's own
identification number moves only the cash line. Linked transactions
and the Article 80 cash payment limit are not enforced.
`docs/EU_AMLR_PACK.md`.

**2026-10-06**, international baseline. A country with no pack is not
given Canada's and is not paused. It operates under `pack-intl-v1`.
Cash foreign exchange is identified at 3,000 USD or more; remittance,
electronic transfer, and virtual currency at 1,000 USD or more; the
large-cash record is 10,000 USD in a fixed 24-hour window. Those USD
lines convert at the newest market snapshot, rounded down to the
cent, and the rate and its timestamp are stored on the deal. The
till reads those converted lines. A missing or stale snapshot (older
than 24 hours) leaves them unset, so identification and the purpose
and source of funds are required on every deal. Settings says that
in those words when the rate is missing. A baseline desk
that names no home currency books in USD. Compliance names
International baseline (FATF), no regulator, and the three generic
reports in plain words. A following line reads the converted home
amount and the US-dollar source in one sentence. A stricter line
names the desk's own figure and the converted baseline separately.
It does not fall back to Canada or FINTRAC. The new-transfer form
treats the typed amount as home currency. A send adds the fee; a
receive uses the payout. That figure is compared with the remittance
line and the desk's own identification line, and the lower one binds.
A missing or stale rate requires identification. A desk already on
the Canada pack version 1 still uses that pack's single line, in
Canadian dollars. A new Canada desk opens on version 2. See
docs/CANADA_PACK.md. The rate tape quotes every
market mid in the desk's home currency (`home per unit = CAD per unit
÷ CAD per home`). The change is that home cross now against the
snapshot about 24 hours earlier. No earlier snapshot, or a current
snapshot older than 24 hours, shows no change percent. An unknown
home currency returns an empty tape, not a Canadian one. The home
currency is not a row on its own tape. When the home rate is missing
the tape shows the published board and no change. A Canada desk's
tape stays Canadian dollars per unit. Foreign cash on any other desk
is valued for identification at the published board's home-per-unit
mid, the same mid the server uses; no mid requires identification.
Deal prices still come from that board. A missing rate is shown as
unavailable. Pipeline, settlement,
and the other desk screens label money in the home currency; a
Canada desk still reads CAD. CurrencyDesk's own subscription prices
stay in Canadian dollars.
The till and Settings show
the international-rules disclaimer, and the threshold editors stay
available. The regulator field is empty. Migration 028 points CAD,
empty, or null home currency at the Canada pack, and every other home
currency at the baseline. The known-wrong country packs are not
assigned. A country pack whose identification lines all equal its
single column still posts on that column. Canada pack version 2 is
the exception, and it is described in docs/CANADA_PACK.md. A blank
identification answer at setup is not filled with the report line.

Prior stamp **2026-10-05**, first-run tour. The tour does not open or raise a window.
A step runs only when that window is already open and in front. Until
then the card offers Open the till or Open the dashboard, and only that
click opens it. The card sits in a gap, clear of the shop figures, the
drawer, the count, and the file list. Skip and Open stay off the desk's
own controls, and the card moves if one shows up underneath them. Skip
stays on the card. Reconcile
and close is not a step. That panel is the close, and the tour does not
count or close cash to make it presentable. Skip or finish is a per-person preference in the
desk document, so a refresh does not bring the tour back. Papers and
identification standing are unchanged.
The KYC badge and identification standing were already separate reads
(a document number on the record, versus the standing the desk stores);
this tour does not write either.

Prior stamp **2026-09-30**, operator file folder. Supporting papers (proof of address,
source of funds, corporate filings) are `supporting_file` rows on
`desk_client_images`. The client record lists them without the bytes;
opening one writes an audit row. A file does not change identification.
The admin desk tile's client count and process standing come from
`desk_clients`. Gallery photos are still browser-only.

Prior stamp **2026-09-30**, platform-operator MFA (issue #33): `/admin` sign-in requires
TOTP once the operator has enrolled. First sign-in enrolls (otpauth URI
shown once; backup codes are scrypt hashes and single-use). The secret is
AES-256-GCM, keyed only from `PLATFORM_MFA_KEY` (required in production;
development and tests use a fixed pepper and never `DATABASE_URL`), not
stored beside the ciphertext. Desk `/login` is unchanged. Until that first
enrollment, an existing password session can still call the admin API —
that is the window in which the current operator sets the authenticator
up, and the panel itself will not open until they do. The session is
the staff user who proved the password, including a desk staff id that
is the platform owner. The browser seam signs that operator in through
the same door, so the panel renders.

Prior stamp **2026-09-30**, signup mobile reaches the admin call. A Canada desk's
setup mobile fills an empty `enquiries.details.phone` at signup or
launch. The applications record shows the call confirmation and
transcript; recordings are not kept. No automatic dial.

Prior stamp **2026-09-11**, product-demo desk on York FX: staff id `demo` (one-shot
`DEMO_STAFF_BOOTSTRAP`) and opt-in `DEMO_POPULATE=1` activity seeder.
Posted through the existing ledger/quote/client services; other tenants
are out of scope. `docs/DEMO_DESK.md`.

Prior stamp **2026-09-09**, storefront SMS holds and rate-board margins are
`numeric`; the public quote path uses Decimal (audit Slice F). JSON
still returns numbers so the storefront `typeof === 'number'` contract
is unchanged. Twilio delivery is unchanged.

Prior stamp **2026-09-09**, `POST /api/quotes` accepts any valid ISO-style currency
code (uppercase 3 letters). The four-way CAD/USD/EUR/GBP enum on
`createBody` is gone; pair and desk-set policy stay in the quote
service. Audit Slice E.

Prior stamp **2026-09-09**, multi-till/workspace resolution (#34): unscoped money
routes use the session workspace rather than "the only workspace at this
branch". The day-at-the-desk seam spec runs in normal order on its own
till. Public `GET /api/health` still pings the database (trivial tenant
read) and returns 503 when that read fails.

Prior stamp **2026-09-09**, `PLATFORM_ADMIN_BOOTSTRAP` is one-shot (`ensurePlatformAdmin`
creates if missing; never overwrites an existing operator password). Issue
#31. Render should still drop the env var after first sign-in.

Prior stamp **2026-09-04**, Engineering standards audit of `main` at
`f31cf21` (#44). Scorecard, residual-issue verification, and proposed
two-line slice end states: `docs/STANDARDS_AUDIT.md`. No product behaviour
changed in that audit.

Prior stamp **2026-08-17** (`90a3890`, #43; recorded on `main` by #44):
live `/login` and `/app` serve `/web/app/os.js` with no unpkg, Babel, or
`react.development`. No must-fix inside the locked compiled-OS slice.
Residual, not blocking: the uncompiled editor shells remain fetchable at
`/CurrencyDesk OS.html` and `/admin.html`; `/onboarding` still lists unpkg
React production URLs in its bundler template. Neither is a product-route
regression. Review this stamp — and every section above — whenever a PR
changes what is true.
