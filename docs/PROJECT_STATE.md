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
| Tenant / session identity | Server sessions + CD-IDs; the server mints all identifiers. Switching staff replaces the session. The name on a deal is that session |
| Frontend truth | Sources: `os-src/`, `design/` (site, onboarding, emails), the root shells. `web/` and `web/app/` are generated output — never edited directly, CI-gated for staleness |
| Calendar days | An ID expiry, a date of birth, a cheque received day, a hold until day, and the till's business date are calendar days. Postgres stores the day. The desk reads that same year, month, and day. The machine zone does not move them. The menubar clock is a clock and follows the browser zone. |

## Production/build surfaces

`marketing site` (`/`) · `OS` (`/app`, `/login`) · `admin` (`/admin`) ·
`onboarding` (`/onboarding/:code`) · `customer storefront` (`/sites/yorkfx`)
· `server/API` (`/api/*`).

## Current active work

New agent pull requests are frozen until the repository owner pushes a commit to main that ends the freeze, except pull requests that finish work already in progress.

- **Cheque fees are the owner's or a manager's.** Sol's rule: the owner and a manager may set the fee, including 0%. A teller, a senior teller, a trainee, and an auditor may not. Who may write `cdos_cheque_schedule_v1` is `canWriteSetting`. Today's default allows a branch manager and a compliance officer. The owner is always allowed, so they cannot be locked out. The table is not stored yet and there is no screen for it. A numeric version that is not current is 409 before the fee refusal. Anyone else gets 403: "Only the owner or a manager can change cheque fees. Ask a manager to make this change." A platform row does not take the save away. A teller's document cannot replace the fee key. The refusal is `settings.cheque_fee_refused`. A save that lands is `settings.cheque_fee_changed`, with who, when, and the old and new price of each cheque type. A type string that is not the stored id is not priced from the schedule yet. That close is a separate change and is not here. The Fee schedule tab is grey, with the lock at the start of that sentence and the sentence wrapped, and no inputs and no Save, for a teller and for a cashier, before any Save. The phone table uses the same card, padding, Fee % column, and sideways scroll as main. Min fee shows two decimals and the example is the body colour, and its header is $2,000.00. A grouped list for the phone is a later change and is not here. The owner and a manager see the table and Save. The header names whoever is signed in now. A refused Save keeps the typed values and shows one amber line above Save. A stale second save shows the conflict line and a 44px Reload, and keeps the typed values. A save that lands shows Saved. A low-fee notice is not here.

- **The desk fits a phone.** At 430px wide and under, a window fills
  the desk instead of floating as a desktop panel. A compact header
  shows the shop name, whether the till is open, and the profile
  button. With no shop logo set, that header has no placeholder box.
  A bottom bar opens Rates, Ledger, Clients, Till, and More.
  The active window is solid. Any window that is not the active one
  is not shown, so the app behind does not read through the cards.
  An unselected tab is #6B6760, 12px on a 16px line, weight 500.
  The selected tab is that app's colour at weight 700, with a 32px
  marker along the top of the tab. The bar is 64px, white, with a
  1px top border and no shadow. A phone draws no
  desktop window chrome: no traffic lights, no title bar, no
  window-title dot, no top icon menu, no logo or store row, no
  dashed Your logo box, and no resize grip. The till line keeps its own open or closed mark.
  More uses the colour of the app it
  opened. When More itself is showing, that colour is #17140F. More lists the other apps that role can already open. There is no
  floating + on a phone. New transaction stays on the ledger, and
  New contact stays where it already was. The header till dot is
  the open session: 8px, #157A3E, with a 2px white ring. The green
  marks drawn into the Ledger and Till icons are artwork, and the
  phone tabs do not use them. The
  module tabs, the menu bar, the shop row, and the store and ID
  rail are hidden. The wordmark, the clock, and the account name
  stay off the phone. A card that holds a table scrolls sideways,
  and the right edge fades. Rounded clips,
  photos, and bars stay clipped. Settings stacks its list above the
  form. Sign-in and the station picker stay on the screen. The window
  title bar is hidden, so the app uses that room. In-app tabs stay.
  A dialog keeps its own header and close, and on a phone it stops
  above the bottom bar. The New transaction sheet is the exception:
  it fills the phone and covers the bar, and the post button stays
  on the sheet. The Cash Drawer header stacks: the title
  and the till on one line, the status under that, the amount, then
  Move cash and Vault. Its tabs scroll, with a fade where the last
  one continues. A ledger reference and a client name stay on one
  line, and their buttons move to the next row. A wide table keeps
  each cell on one line and scrolls inside its card. The desktop
  resize grip is hidden. The rate board leads with its currency rows,
  already drawn. The cash-drawer count keeps its currency chips and
  Save count on screen. The whole Cash drawer scrolls as one column,
  so the header, the session line, and the hand-off scroll away and
  the denomination rows use that room. The count panel stays a solid
  sticky panel pinned directly above the bottom bar, with nothing
  drawn behind it. The list ends with room for that panel, the
  bar, and 16px, so the last denomination can scroll clear of the
  panel. An uncounted drawer says "Not counted"
  rather than a lone dash — the ledger amount stays on the "In drawer"
  pill, because a zero would claim the drawer was counted empty.
  The ledger search is one line, with its help mark in that line.
  The compliance header stacks Screening, Reportable, and Structuring.
  Screening reads Not connected. Wider than 430px, the desk is
  unchanged: the dots stay 12px, and the module tab bar ends before
  the store and ID buttons.
- **New transaction on a phone.** Under 600px the dialog is a
  full-screen sheet, one column. The type names are one scrolling
  row of pills, and the selected pill is in view when the sheet
  opens. That row scrolls away with the fields. The customer search
  is one row: icon, name, clear. The suggestion list closes when
  focus leaves it. When the customer needs identification, the sheet
  shows one row, "ID needed for this amount", and "Record the ID".
  That opens the client file's identity editor (type, number, issued,
  expiry, and the scan) and saves the document on the server, then
  returns to the deal. The phone does not keep a type and number that
  exist only in this browser. The deal ticket follows the fields in
  the same scroll. The quote button and the post button stay on
  screen for the whole sheet, including while the amount is focused
  and while the keyboard is open. The X is 44px. If the ticket has
  anything entered, the X asks "Discard this deal?" before it closes.
  Swap and Override are 44px targets, and the swap control is 44×44
  on the rate line. The customer clear control is 44px. Text quote
  is hidden unless SMS is configured, and the $6.99 verify nudge is
  hidden while Persona is off. An incomplete deal says "N steps
  left" and stays tappable; tapping it scrolls to the first missing
  item and marks it. The checklist says "ID not recorded yet" and
  offers Record the ID. Rates show four decimals. Ticket amounts
  include the currency code. The amount the customer receives is
  the text colour in the field and white on the dark ticket. Green
  stays on the margin. Purpose and source of funds stay in the ordinary
  border until the cashier leaves an empty field. The "Authoritative
  ledger record" heading is hidden; the two fields stay, because
  the server still requires them. The checklist names them "Purpose
  and source of funds" with "Needed for this amount", and tapping
  that line is a 44px target, and tapping it scrolls to the fields
  and focuses the first. Before you post, the Ready count, the
  date, and the rate line use the phone ink #6B6760. The buy
  and sell badge reads "We buy" or "We sell", blue on pale blue and
  purple on pale purple. Exchange, Margin, Before you post, the
  steps-left count, and the rate line are 13px sans, sentence case.
  Mono stays on references. A date reads
  like "Oct 11, 2026", including the header and an ID expiry. The
  amount field keeps what was typed. The customer stats read "ID on file"
  and "Last {n} days". The type row keeps a 16px inset and fades the pills
  at the right edge. Record the ID is one column, so the ID type is
  not cut off. Its subtitle is "Type, number and expiry". Customer,
  the amounts, the rate, and the required fields are the full width of
  the form and at least 44px tall. The
  text in those fields is 16px, so the phone does not zoom in when
  a cashier taps one. A long value ends in an ellipsis. At 1280 the
  dialog is the same two columns as before this phone work. Text
  quote still shows, an incomplete deal still says "N to complete"
  and stays disabled, and the ledger heading still shows. The ID
  row, the discard question, and the phone footer are not on that
  dialog.
- **Philippines pack `pack-ph-v1` (draft).** A new Philippines desk
  opens on this pack, in PHP. Existing desks do not move. Money
  changing and remittance are identified above 5,000 PHP. Other
  occasional deals are identified above 100,000 PHP. A single deal
  over 500,000 PHP is flagged as a covered transaction. Deals in one
  banking day are not summed. The stricter reading, a banking-day
  total under RA 11521 section 2, is listed. The till does not add
  the day. A cash payout over 500,000 PHP, and a
  sale of foreign currency over 10,000 USD, are refused. The desk
  does not file to the AMLC. No sanctions list is loaded. The desk
  says screening is not connected. It does not name a sanctions
  list, and it does not show a hit count or a seeded subject. It
  says Philippine law requires the owner to screen clients and
  counterparties, including against the ATC list, and on a match to
  freeze without delay, tell the AMLC the same day, and file an
  STR. The owner does this outside the desk.
  The website stays Not live. Canada is the only Live country.
  Write-up: `docs/PHILIPPINES_PACK.md`.
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
  Password guesses on that door are limited: five wrong passwords on
  one account, or twenty from one address, inside fifteen minutes, and
  the next answer is "Too many tries. Try again in N minutes." The
  count is a Postgres row, so a restart does not clear it. An unknown
  staff id gets the same sentence. The emailed-code step answers with
  the same words, in the same time, for an unknown id and a wrong code,
  and it will not check a code unless this browser already passed the
  password (a server-side marker). If `RESEND_API_KEY` or `EMAIL_FROM`
  is missing in production, the send is refused and the code is not
  written to the log.

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

- **Sanctions screening is not connected.** The Compliance screen
  used to match client names against a sample of ten fictional
  names and present the result as OFAC, UN and OSFI screening. That
  list is gone. The compliance screens do not name those lists and
  do not show a seeded subject as a result. The Screening tab says
  screening is not connected
  and that the owner checks their government's official lists.
  Settings shows that same sentence. The Compliance header tile and
  the dashboard tile say not connected, and neither shows a count.
  A hit count of zero is not shown, because zero would read as
  "all clear". The built bundle Render serves has no hits count
  and no "screened against OFAC, UN and OSFI" sentence. The sample
  wires (t1–t4, including the $14,200 transfer) are not filings,
  aggregates, or a cross-border report on the compliance surfaces.
  The sample beneficiaries are not listed on a client file. Saving
  a contact does not mark it verified and does not invent an
  address or an ID number. The client file does not say a Persona
  check is running. Settings billing does not show a check count
  or a charge.
  The Texts journey does not say an identity check was sent. Persona
  is not connected.
  `sanctionsListShips()` stays false for the Philippines
  (`pack-ph-v1`), Singapore (`pack-sg-v1`) and Hong Kong
  (`pack-hk-v1`), and it is false for every other pack as well.
  Those three still add their own duty under the sentence. That
  duty does not name a sanctions list. A teller sees that
  not-connected state on the Compliance window: the Screening
  tile reads not connected and shows no count. The Dashboard
  sanctions tile, which an owner opens, reads not connected and
  shows no count. A cashier's dock does not include the Dashboard.
  The Store roadmap card for Compliance AI Pro is tagged
  Planned. It says screening is not connected yet. It does not
  say the screen is live. No list is fetched
  and no name is matched.

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
  029, 031, and 034 are already on main. 027 and 030 are still open
  drafts. Sources, the article table, and the gaps: `docs/SERBIA_PACK.md`.

- **United Kingdom desks open on pack-gb-v2.** The Money Laundering
  Regulations 2017, sterling figures in force from 30 June 2026
  (SI 2026/621): customer due diligence on an occasional transaction
  of £12,000 or more, and on a transfer of funds of more than £800.
  There is no large-cash report. A suspicious activity report goes to
  the NCA (UKFIU), with no amount, as soon as is practicable. HMRC
  supervises the business. Records are kept five years. `pack-gb-v1`
  is not edited. A desk already on it stays there until an
  administrator opts in. Posted deals keep the pack they were stamped
  with. A number the desk types can still be stricter. It cannot
  raise the £12,000 occasional floor or the £800 transfer floor. The full
  article table, the sources, and the gaps are `docs/UK_PACK.md`.
  Migration 035. 029, 031, 033, and 034 are already on main. 027 and
  030 are still open drafts, so 035 stays.

- **India pack** — a new desk that signs up as India opens on
  `pack-in-v1` (migration 037). Home currency INR. Regulator string
  `RBI / FIU-IND`. A cash transaction report flags a single cash deal
  more than 10 lakh rupees, comparator `gt`. Exactly 10 lakh is not a
  report. Connected cash in an Asia/Kolkata calendar month is not
  summed yet. `indiaCtrFindings` can group one customer across that
  month, and nothing calls it. The desk must check those deals. The
  report is due by the 15th of the next month. Walk-in customer due
  diligence is 50,000 rupees or more. A remittance or electronic transfer is every
  deal. A suspicious report is stored as 7 business days, with no
  holiday calendar. Cross-border wires (more than 5 lakh, monthly) and
  counterfeit notes are catalogue rows. The till cannot mark a
  counterfeit note and does not file to FINNET. Cash taken for a sale
  of foreign exchange at 50,000 rupees or more is refused. The resident
  USD 1,000 cash payout is not enforced. Records say 5 years. Existing
  desks are not moved. The website does not call India Live. Detail:
  `docs/INDIA_PACK.md`.
  029, 031, 033, 034, 035, and 036 are already on main, so 037 stays.
  027 and 030 are still open drafts.


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
  `siteSlug=yorkfx`. It also states a vault opening position (CAD
  40,000, USD 20,000, EUR 10,000, GBP 5,000) once, so a float comes
  out of the safe. A book that already has its history and has never
  stated a vault position still gets that count. A later boot does
  not add it again once the safe has been counted. Login
  is `/login` → `/app`, not `/admin`. How to run it: `docs/DEMO_DESK.md`.

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

**2026-10-17**, cheque fees. The owner and a manager can change the cheque fee schedule, including to 0%. A teller, a senior teller, a trainee, and an auditor cannot. Who may write it is `canWriteSetting`. Today's default allows a branch manager and a compliance officer, and the owner is always allowed. That table is not stored and has no screen. A stale numeric version is 409 before the fee refusal. A platform row does not remove the save. A teller's document cannot replace the fee key. A refusal is 403, the stored schedule is unchanged, and the audit action is `settings.cheque_fee_refused`. A save that lands writes `settings.cheque_fee_changed` with who, when, and the old and new price of each type. A type string that is not the stored id is not priced from the schedule yet. That close is a separate change and is not here. The Fee schedule tab is read-only for a teller and for a cashier, with no inputs before any Save, the sentence wraps, and the phone table uses the same card, padding, Fee % column, and sideways scroll as main. Min fee shows two decimals, the example is the body colour, and its header is $2,000.00. A grouped list for the phone follows in its own change. The header names the person signed in now. A second save against a newer version keeps the typed values and shows a 44px Reload.

**2026-10-12**, shop sign-in. A wrong password at `/login` is counted in
Postgres, five per account and twenty per address, for fifteen
minutes. The count is written before the answer, so a burst cannot
slip a correct password through after the limit. The lock says "Too many tries. Try again in N minutes." The screen says "Too many tries. Try again at 10:42 AM." The hour is the shop's own clock, so the zone is not repeated. While that holds, the button reads Sign in, with a lock, and it is disabled. It comes back when that time passes. With no time from the server it says "Too many tries. Try again in a few minutes." and Try again sends the password once more. Asking for another code while locked says "Too many tries. Try again at 10:42 AM." A staff id with no @ does not see the email-code line. not you?, SHOW, and the reset link are 44px. Forgot it? and the OS mark use the body grey (#6E675E), so each clears 4.5:1. A staff id with no @ is password-only: the button reads Sign in on that step and again after the lock ends. The greeting uses the display name, as in Welcome back, M. Costa. The lock hour is the shop clock in America/Toronto, including when the process zone is Asia/Jerusalem. An unknown staff id gets that same sentence. A valid `CF-Connecting-IP`, including IPv6, is the client when the
socket is a published Cloudflare address, or when the socket is a
private address and the rightmost `X-Forwarded-For` hop is Cloudflare.
IPv6 /64 rotation is accepted for now and is a follow-up. A missing
or invalid header counts the socket and warns without the header
value. Otherwise a private socket counts the rightmost hop, and
anything else counts the socket. The first request logs the header
names present, with no values and no IPs. Render's docs say the app
sees the proxy IP and that the first `X-Forwarded-For` entry is the
client. This count does not use that first entry. A caller-supplied
header cannot open a new bucket unless the hop is Cloudflare.
Production mail uses `is not set` for one missing name and `are not
set` for both, and a provider error body that cannot be read still
logs the status. An owner or a
manager can clear the account
counter, and `RESET_STAFF_PASSWORD` clears it too. The emailed-code
step gives one answer, in the same time, for an unknown id and a
wrong code, and it checks a code only after the password step has
left a server-side marker. A wrong code says "That code isn't right.
Check your email." Production without `RESEND_API_KEY` or
`EMAIL_FROM` does not send and does not log the code. Migration 044. 041 is claimed by open drafts
#96, #110, #120, and #132, 042 by #130, and 043 by #138.

**2026-10-12**, serialization retry. A post that Postgres aborts with 40001 is run
again, up to six times. The aborted attempt wrote nothing. The same
idempotency key makes the next attempt the same post. A quote the other
attempt has already posted is that stored post, not a refusal that the
quote is no longer active. A key already saved with no stored answer
posts once. It is not refused as IDEMPOTENCY_IN_PROGRESS. The teller
sentence for that code is "This request is already being posted.
Nothing else was posted."

**2026-10-12**, platform write gates. An auditor on the platform team can
read desks, applications, billing, people, and the audit trail. They
cannot suspend or delete a desk, create one, change a plan, reset a
password or a PIN, issue a CD-ID, block a person, invite a desk, or
edit an application. Suspending and deleting a desk require
`security:manage`. Changing a plan requires `billing:write`. A body
that does both has to hold both, and nothing is written until both
checks pass. Creating a desk by hand requires `desks:write`. Acting
on a person requires `people:write`. An invitation and an application
edit (notes, status, answered, labels, rotating the code) require
`applications:write`. Support does not suspend a desk and does not
change a plan. That loss of suspend and delete is the rule. The need
is read from the fields on `PATCH /api/admin/tenants/:id` and checked
before the body is validated, so a caller who does not hold it gets
403 even when the body is bad. A read still answers any platform role.

**2026-10-12**, cheque reversal door. `POST /api/ledger/transactions/:transactionId/reversal`
refuses `cheque_cashing`, `cheque_clearing`, and `cheque_return` with
`REVERSAL_NOT_ALLOWED`. The message names
`POST /api/ledger/cheques/:chequeId/reversal`. A generic reversal of a
cashing used to put the cash back, leave `ledger_cheques.status` as
held, write no cheque event, and then refuse the cheque route forever
with `REVERSAL_ALREADY_EXISTS`. A clearance and a return were the same
hole on their own transaction rows. The cheque route itself is unchanged.

**2026-10-12**, PIN guesses. A wrong PIN, and a wrong sign-in password on the
forgot-PIN door, is counted before the slow check. That guess is given
back as soon as the current PIN or password checks out, so a later
refusal does not count. Only a wrong current PIN, or a wrong password
on that door, counts. A right PIN on the keypad gives the run back.
A burst of wrong guesses still stops at five. The lock still lives in
memory on this process.

**2026-10-12**, staff switch. Taking the desk from the avatar menu is a new
session. `POST /api/auth/switch` checks the next person's server-held
PIN. A missing PIN, a manager-issued PIN they have not replaced, the
guess `0000`, and a locked keypad are said inside the PIN dialog. The
name is an initial and a surname, and the space between them does not
break. `0000` and the other easy PINs are refused when someone sets a
PIN, not only when they switch. `0000` on a switch does not count as a
wrong try. Five wrong tries lock the keypad, and the lock clears on
its own in 5 minutes. The dialog's Cancel key uses the desk font at
15px. The route revokes the cookie that was live and issues one for
them. Two switches from the same cookie cannot both win. The till
session belongs to whoever counted it. A switch does not hand it over.
A teller or a supervisor keeps that workspace only when they counted
it, or when nobody has. A manager, an auditor, or compliance can stay
on it to look or to approve, and they do not become the person who
counted it. Anyone else is asked to pick a till. A deal, and cash in
or out, on a till somebody else counted is refused until the new
person does a handover count. A manager may approve. They may not
move the cash. A mid-day count is only for the person who holds the
till, and a count reply to anyone else carries no expected amount.
The handover is a blind count. It closes the old session, writes the
variance on that session, and records the person who counted as the
closer and the counter. It opens a session they counted. The screen applies the role
`/api/auth/me` returns after the switch. The Settings toggle that used
to skip the PIN does not skip the server. A deal, a till open, and an
audit row carry the new session. The first-run tour is once per person,
on sign-in. A switch or a handover does not open it and does not mark
it done. Before this, a successful switch wrote nothing, so a deal
whose screen said one person and whose `actor_id` is another cannot
be found with a query.

**2026-10-12**, teller earnings. A teller can post a deal and still cannot
read what the desk earned. The customer-facing fee stays, because the
customer was charged it. `GET /api/ledger/summary` keeps `feesHome`
and leaves off `earningsHome`, `realizedPnlHome`, `costOfSaleHome`,
the same money on each teller (`feesHome`, `earningsHome`,
`realizedPnlHome`), and `realizedPnlHome` on each currency. The
transaction list keeps `feeCad` and leaves off `spreadCad`,
`costOfSaleHome`, `realizedPnlHome`, and `marketMid`. A reprinted
receipt still prints the fee line. Position leaves off
`unrealizedPnlHome`, `costBasisHome`, `marketValueHome`, the market
unit, and the average cost, and it keeps the quantity. The cheque
register keeps `feeAmount`. A quote that is still being priced keeps
its fee and its spread. Once that quote is posted, cancelled, or
expired, the read and the post and cancel acknowledgements leave off
the spread and the mid. The ledger does not offer a teller the
earnings sheet, the view-earnings link, or empty spread, revenue, and
margin cards. Closing the day (`till:close`) is what opens those
reads. A teller cannot close the day. An owner, a supervisor, and a branch manager close
the day and still see the figures. An auditor and a compliance
officer do not close the day, and they do not hold
`report:earnings`, which is the same as on main. That permission
exists and nobody holds it. Granting it is a later decision.

**2026-10-11**, phone bottom bar. At 430px and under, the header is the
shop name, a till dot that reads Till open or Till closed, and the
profile button. Five tabs sit on a fixed bar: Rates, Ledger, Clients,
Till, More. More is the other apps that role can open. There is no
floating +. New transaction stays on the ledger, and that sheet
covers the bar. The window title
bar is hidden; the app fills that space and scrolls under the
56px header and the 64px bar. The active window is solid, and a
window that is not active is not shown. In-app tabs stay. A ledger record
has its own Back, because that was the one action that lived only
in the title bar. The bar includes the iPhone safe area.
The Cash Drawer header stacks down the screen instead of collapsing
the title into a narrow column. A ledger reference
and a client name stay on one line. A wide table scrolls inside its
card instead of breaking each column into single words. An unselected
tab is #6B6760, 12px on a 16px line, weight 500. The selected tab is
that app's colour at weight 700, with a 32px marker along the top of
the tab, and so is the open in-app folder tab. The window-title dot stays off the phone
header. A phone shows no desktop window chrome: no traffic lights,
title bar, top icon menu, logo or store row, dashed Your logo box, or
resize grip. With no shop logo set, the phone header is the shop name.
The till line keeps its open or closed mark: an 8px #157A3E dot
with a 2px white ring while the session is open. On the cash
drawer the whole column scrolls, and the count panel is a solid
sticky panel pinned to the bar. More uses the colour of the app it opened, or the ink when
More itself is showing. Wider than 430px, the desk is unchanged. Rate rows lead the
rate board. The drawer count keeps its chips and Save count in view,
and says "Not counted" until a currency is counted. The ledger search
stays one line. Screening reads Not connected. This sits on the phone
layout that landed with the desk-fits-a-phone change.

**2026-10-11**, public site claims, fourteenth pass. Only
the exact names "24-hour rule" and "24-hour aggregation rule"
are kept. A 24-hour setup fails. Spaced 48 hour and 2 hour,
two-hour, less than two hours, over-night, and replies today
fail. A comma after the SMR terrorism-financing clause does
not keep the deadline.

**2026-10-11**, public site claims, thirteenth pass. The
SMR terrorism-financing deadline is allowed only as that whole
clause, on the compliance page and the FAQ. A longer sentence
does not borrow it, and the clause fails on the homepage. A
hyphenated live-rates, a dash entity, and en, em, and hair
spaces cannot hide a timing claim. 2-hour, within the hour,
next-day, reply today, and a board that moves with the market
fail. The contact page still says a reply within one business
day, so that phrase is not banned.

**2026-10-11**, public site claims, twelfth pass. The
claims check allows a regulator clause only when that clause is
the whole clause, and only when the clause itself contains a
banned pattern. The kept clause is the Australia SMR terrorism
financing deadline. US CTR and SAR phrases are not on the list.
A tag inside a word, an unquoted meta value, a hyphen entity, a
thin space, and a fullwidth dash cannot hide a phrase. 48-hour,
less than an hour, overnight, every second, always current, and
plenty of shops fail. The publish step no longer says the board
is always current. The legal page says early access once.

**2026-10-11**, public site claims, eleventh pass. The
onboarding greeting says the desk is set up. The homepage and the
mobile page say available in Canada, early access, where they used
to say live in Canada. The Live and Not live country labels stay.

**2026-10-11**, public site claims, tenth pass. The homepage
says a rate board built from market rates, and the setup step says
mid-market rates. The legal page says the service is in early access
in Canada. Onboarding says you are ready to trade once the desk is
set up. The homepage button says See a demo. The FAQ no longer says
the software is handling live money, or that a market is going live.
The early-access question asks when you want to start. Onboarding no
longer says the public page goes live, that rates are pushed live, or
that someone calls after you go live. The claims check rejects
handling real work, see it live, and live board. Live rate board
stays the plan name.

**2026-10-11**, public site claims, ninth pass. The pricing
point says mid-market rates are refreshed regularly. The server
pulls them on `RATES_SYNC_MINUTES`, 60 minutes unless that is set
otherwise, so the page does not say hourly. The Australia cards on
the homepage and the mobile page no longer carry an SMR line.
Australia stays marked Mid 2027.

**2026-10-11**, public site claims, eighth pass. Unicode
dashes fold to an ASCII hyphen before the two readings. A
regulator deadline is kept only on the compliance page and the
FAQ, and only when it is one of the deadlines those pages cite,
each starting with the report name. A report name later in the
sentence does not keep a different deadline. The checker also
rejects 48h, Nh, N hrs, under N hours, and replying today. The
homepage description names the rate board. The site feature says
buy and sell rates are published from the desk. The onboarding
preview says Board preview (sample), with no pulsing dot. Contact
asks for a note and does not time the reply. The Rates plan keeps
the name Live rate board, and the checker allows that exact phrase.

**2026-10-11**, public site claims, seventh pass. The desktop
footer has no clock. The public rate board says it is a sample, and
its figures do not move. The onboarding landing has no clock and no
LIVE pill. Its ticker starts with a fixed "Sample rates" tag. The
FAQ does not say owners stop using their old books within a
fortnight. The claims check also rejects an N-minute compound,
same-day, a fortnight, within N hours, in N hours, 24/7, real-time,
and live rates. A regulator deadline that names SMR, STR, SAR, TTR,
CTR, or IVTS may still say within N hours.

**2026-10-11**, public site claims, sixth pass. The mobile
hero strip says "Sample rates" above the figures, in the strip
itself. The desktop hero card is titled "Sample rates", with no
green status dot and no clock. The black ticker starts with a
fixed "Sample rates" tag that does not scroll.

**2026-10-11**, public site claims, fifth pass. The mobile
hero rates are labelled Sample. They do not move, and the strip
does not show a clock or a pulsing dot. The public pages do not
give a measured time for a visit, a reply, or setting a desk up.
The claims check rejects "in seconds", "in N seconds", "in N
minutes", a minutes duration, "N seconds", "same afternoon",
"same day", "about a week", and "within a week", on both readings
of a soft hyphen or a zero-width character. Onboarding says
"Encrypted connection", and that Stripe checkout is not connected
yet. The mobile copilot card is tagged Planned.

**2026-10-11**, public site claims, fourth pass. The onboarding
line about a rate board no longer says plenty of shops run on it.
It says you can run on that alone and add a site whenever you want
one. The claims check reads each page twice, once with zero-width
characters and soft hyphens deleted and once with them turned into
spaces, and a banned phrase on either reading fails. It also rejects
"UN list", "United Nations list", and "best protection". `check:parse`
and `check:sanctions` both stay.

**2026-10-11**, public site claims, third pass. The onboarding
agreement does not say client verification is billed. The site does not
name a most-chosen or most-popular plan, and it does not give a measured
time for closing the day or for a repeat deal. Per-tier KYC prices are
off the public pages. One planned price remains: from $3.99 a check,
and nothing is charged today. The claims check also rejects dotted
acronyms, OSFI, a singular real shop, invisible splits, "screened
against", and "sanctions screening" except the sentence that it is not
connected.

**2026-10-11**, public site claims, second pass. There are no shops on
the product yet. Canada is the only live country. Serbia, India and the
Philippines are marked not live, and their rule tags no longer say they
are on the desk. The site does not say deals are running in real shops,
that a first shop exists, that anything was measured at the counter, or
that history is imported. History is entered by hand. ID verification is
not billed. The only service providers named are Render (hosting, United
States) and Neon (database). Hero and feature amounts that are not a
regulatory threshold are labelled sample figures. A large cash worksheet
can be prepared from the book and is not sent. The 24-hour window on the
server starts at midnight in the branch time zone. Screening is not
connected. Texting is not connected. The site does not claim encryption
at rest, and it does not claim data is held in the region where the desk
operates. Subscription prices printed on the site are unchanged.

**2026-10-11**, New transaction on a phone, follow-up. Under 600px
an incomplete deal says "N steps left" and stays tappable. Tapping
it marks the first missing item. The checklist says "ID not
recorded yet". Text quote is hidden unless SMS is configured, and
the verify nudge is hidden while Persona is off. Rates show four
decimals. Ticket amounts include the currency code. The amount
the customer receives is the text colour in the field and white
on the ticket. The badge reads "We sell" or "We buy" in the sell
and buy colours. Exchange, Margin, Before you post, and the rate
line are sentence case in the sans face. The checklist says
"Purpose and source of funds" and "Needed for this amount", and
tapping it scrolls to those fields. That target is 44px. Before
you post, Ready, the date, and the rate line use #6B6760. The
customer stats read "ID on file" and "Last {n} days". Purpose and
source borders turn red only after an empty field is left. The
ledger-record heading is hidden. The type row keeps a 16px inset
and fades at the right edge. Record the ID is one column, and its subtitle is "Type, number and expiry".
A date reads like "Oct 11, 2026". The amount field keeps the digits
that were typed. Recording
an ID for a customer who already has a file posts the document on
that file. Wider than 600px, including 1280, the dialog is unchanged:
Text quote shows, and an incomplete deal still says "N to complete"
and stays disabled.

**2026-10-11**, New transaction on a phone. Under 600px the form is a
full-screen sheet and one column. The type names are a horizontal
row of pills, with the selected pill in view on open, and that row
scrolls away with the fields. The customer row is icon, name, and
clear on one line. The suggestion list closes when the amount is
focused. A deal that needs identification shows "ID needed for this
amount" and "Record the ID", which opens the client file's identity
editor and saves type, number, and expiry on the server, then
returns to the deal. A type and number typed only into the browser
is not how this sheet records an ID. The quote and the post button
stay on screen for the whole sheet, including with the keyboard
open, and the last field can scroll clear of them. The X is 44px.
If anything has been entered, it asks "Discard this deal?" with
Discard and Keep editing. Swap, Override, and Text quote are 44px
targets. With the bottom bar on the phone, the sheet covers the
bar, so the post button is not under it. Other dialogs still stop
above the bar. Wider than 600px, including 1280, the dialog matches main.

**2026-10-10**, Till close. A close names the mark the count was taken
against. The screen pins that mark when the first figure is entered
and keeps it until the day is closed or the count is cleared, so a
refresh in the middle of the count cannot close against a newer
drawer. If a deal or any other movement has changed the drawer since
that mark, the close is refused with "Money moved since you counted.
Count again." The old figures are not written back. A tab that posts
a close with no mark is told "The desk was updated. Reload, then
count again." A close of a drawer that has not moved still lands.
The mark is migration `040_till_balance_generation`. `039` is on main;
this file follows it.

**2026-10-10**, Vault float. Taking cash from a vault that has no opening
count is refused. The till is not credited, and nothing is subtracted
from a figure the book does not have. The message is "Open the vault
with a starting count first." Cash that arrives from a bank still posts.
The York FX demo states a vault opening, so a float on that desk comes
out of the safe.

**2026-10-10**, Demo vault. York FX populate states a vault opening
position once. A float of 500.00 CAD takes 500.00 out of that safe
and puts it in the drawer. A second populate leaves the safe where
the float left it. A desk that already has its history, and has
never stated a vault position, still gets this count: populate does
not return before that opening.

**2026-10-10**, Cash moves. An opened Move cash form, an issue-to-till form
(one key per currency), and a wholesale delivery form each keep one
idempotency key until that movement finishes, including a retry and a
second tap. Two requests that arrive together under that key replay
the one movement. A known key whose amount, currency, direction, or
the rest of the movement differs is refused, and nothing else moves.
A new form is a new movement.

**2026-10-10**, Cheque cashing. An opened cheque form keeps one idempotency
key until that cashing finishes, including a retry and a second tap.
The server also refuses a second live cheque at the same branch with
the same number and payer, and the same bank when both sides stored
one. A missing bank matches. A different bank is different paper. A
cheque that has cleared, been returned, or been reversed can be cashed
again. Migration 039. A book that already holds two live copies still
boots: the older copy stays held and is left out of the unique index
(`paper_guard` false). The newest copy is the row the index watches.

**2026-10-11**, Sanctions screening. The sample watchlist is not shown.
The Compliance screen, the header tile, Settings, and the dashboard
tile say screening is not connected. The tiles do not show a count.
The built `web/app/os.js` bundle is what Render serves, and it does
not contain a hits count. Demonstration wires are not counted as
filings. The client file does not offer a Persona check, does not
list the sample beneficiaries, and does not fill in an invented ID.
Settings billing
says nothing was charged. The Texts journey does not say a check was
sent. Philippines, Singapore
and Hong Kong stay false in `sanctionsListShips()`, and so does every
other pack. The Philippines line still states the owner's duty:
screen clients and counterparties, including against the ATC list,
freeze without delay, tell the AMLC the same day, and file an STR.
The compliance screens do not name a sanctions list, do not show a
hit count, and do not present a seeded subject as a screening
result. A teller sees that state on the Compliance screen. The
owner sees it on the Dashboard sanctions tile. A cashier's dock
does not include the Dashboard. The Store card for Compliance
AI Pro is tagged Planned and says screening is not connected yet.

**2026-10-07**, Tagged screen. Opening it threw `deskFacts is not defined`
because the follow-up list named that version number without
declaring it. The screen opens. Its flags refresh when the
trading day or the pack arrives, the same way the ledger does.

**2026-10-08**, phone layout. At 430px wide and under, windows fill the
desk. The menu bar keeps its buttons. A window header puts the title
on one line and the buttons on the next row. A card that holds a
table scrolls sideways, and so do the folder tabs; the right edge
fades so the cut is a scroll, not a clipped word. Rounded clips,
photos, and bars stay clipped. Settings stacks its list above the
form. The phone-width check opens sign-in, the Rate Board, Ledger,
Clients, Cash Drawer, Compliance, and Settings at 390px and at 360px.
A control cut off by overflow:hidden fails that check. Only a box
you can scroll counts as contained. A window title that meets a
window dot, or a module tab that meets the store or ID button, fails
that check too. The dots stay 12px. The tab bar ends before those
buttons. That check caught the menu clock still showing (it pushed
the power button off the screen), the window resize handle past the
edge, the Settings rail leaving the form a sliver, the 44px dots
covering the title, and the store and ID buttons covering the Ledger
tab. Those are fixed here. Tagged is not part of this change.

**2026-10-07**, Philippines pack. A new desk in the Philippines opens
on `pack-ph-v1`, in PHP. An existing desk is not moved. Money changing
and remittance require customer due diligence above 5,000 PHP. A bill,
an electronic transfer, a cheque, and virtual currency require it
above 100,000 PHP. Exactly those amounts do not. A single deal over
500,000 PHP is flagged. Deals in one banking day are not added
together, and the desk does not claim they are. The stricter reading
is a total within one banking day under RA 11521 section 2. AMLC
Regulatory Issuance No. 1, Series of 2021 (30 January 2021), states
one transaction and does not restate the day. That total is listed.
The open question is whether that issuance narrowed the statute. The
till does not add the day. Purpose and source of
funds are required only above 500,000 PHP. A cash payout over 500,000
PHP, or the foreign-currency equivalent, is refused. A sale of foreign
currency over 10,000 USD, or the equivalent, is refused. A missing or
stale rate blocks those conversions. The desk does not file to the
AMLC. No sanctions list is loaded. The desk says screening is not
connected. It does not name a sanctions list. It says Philippine
law requires the owner to screen clients and counterparties,
including against the ATC list, and on a match to freeze without
delay, tell the AMLC the same day, and file an STR. The owner does
this outside the desk.
Records are kept five years and are not deleted. The public site says
Not live. Canada remains the only Live country. See
`docs/PHILIPPINES_PACK.md`. Migration 038 stays. 029, 031, 033, 034,
035, 036, and 037 are already on main. 027 and 030 are still open
drafts.

**2026-10-07**, India pack. A new India desk opens on `pack-in-v1`.
A country with no pack is still not given Canada's. See
`docs/INDIA_PACK.md`.

**2026-10-07**, United Arab Emirates pack version 2. A new UAE desk
opens on `pack-ae-v2`. A desk already on `pack-ae-v1` stays there
until an administrator opts in (`POST /api/ledger/jurisdiction-pack/ae-v2`).
Posted deals keep the pack stamped on them. There is no cash threshold
report at AED 55,000. Foreign exchange identification is AED 3,500 or
more, and that floor cannot be raised. One foreign exchange of AED
35,000 or more requires purpose and source of funds. A money transfer
requires identification, purpose, and source of funds at any amount.
STR and SAR are goAML catalogue rows. Fund Freeze Report and Partial
Name Match Report (PMNR) are catalogue rows. Records are kept 5 years.
The 90 day and 45 day bands are not summed. Detail, sources, and the
gaps are in `docs/UAE_PACK.md`. Migration 036 stays. 029, 031, 033,
034, and 035 are already on main. 027 and 030 are still open drafts.

**2026-10-07**, United Kingdom pack v2. New GB and UK desks open on
`pack-gb-v2`: occasional customer due diligence at £12,000 or more,
transfers of funds of more than £800, no large-cash report, SAR to
the NCA, records kept five years. `pack-gb-v1` is unchanged until a
desk opts in. Posted deals keep their stamp. See `docs/UK_PACK.md`.

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
the exception, and it is described in docs/CANADA_PACK.md. A new
UAE desk opens on `pack-ae-v2`, which reads one line per kind of deal.
A desk already on `pack-ae-v1` stays there until an administrator opts
in. A blank
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
