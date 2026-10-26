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
Deployed as **one Render web service** (`render.yaml`). Live auto-deploys from `release`.

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
| Calendar days | An ID expiry, a date of birth, a cheque received day, a hold until day, and the till's business date are calendar days. Postgres stores the day. The desk reads that same year, month, and day. The machine zone does not move them. A till session and a handover stamp the branch's own timezone (`branches.timezone`), so a process on UTC still writes the branch's civil day. The menubar clock is a clock. It follows the desk timezone (`settings.timezone`) and the desk's time format, 12-hour unless the desk set 24-hour. |

## Production/build surfaces

`marketing site` (`/`) · `OS` (`/app`, `/login`) · `admin` (`/admin`) ·
`onboarding` (`/onboarding/:code`) · `customer storefront` (`/sites/yorkfx`)
· `server/API` (`/api/*`).

## Current active work

- **Staging routes share one door.** `stagingDoorOpen` in `server/src/auth/staging-runtime.ts` is that door. With no request it is `STAGING` exactly `1`, which is when `GET /api/staging/signin`, `POST /api/staging/enter`, `POST /api/staging/fresh-shop`, and `POST /api/staging/fresh-onboarding` are registered. With a request it is that flag plus `isStagingRuntime` on the Host header. `x-forwarded-host` is not read, so a live host stays closed when that header names the staging host. The six role buttons still require the demo shop `tnt-yorkfx`. Migration 056 adds `tenants.is_test_shop` (not null, default false). Postgres adds it only in that file. The shared boot DDL does not, so a leftover column is not adopted before the migration runs. 056 raises unless the column is absent or is already boolean not null default false. A text column, a nullable boolean, or a boolean whose default is true stops the migration, leaves the shop row as it was, and does not record 056. PGlite runs that same file because it does not run SQL migrations. A database already at 055 with no such column gains it as false. A verified fresh shop sets it true. Issue #412.

- **Staging can open a fresh shop.** `POST /api/staging/fresh-shop` is registered with the same door as the role buttons (`STAGING` exactly `1`). Each request calls `stagingDoorOpen` on the Host header. A live host, a missing host, a spoofed `x-forwarded-host`, or a spoofed `Forwarded` header is 404. The body is ignored, so the call cannot name `tnt-yorkfx`. It holds a pending signup the same way `POST /api/signup` does: slug `stg-<8 hex>`, owner `owner+<id>@staging.invalid`, plan trial, no regulator. The 6-digit code and a one-time password are in that response and nowhere else. Only the hashes are stored. The code is not emailed and is not written to the log. Live signup still emails its code and still returns `{ ok, email }` with no code. It refuses `@staging.invalid`. `POST /api/signup/resend` does not mint a new code for that domain. `POST /api/signup/verify` is the real code step. The right code calls `provisionDesk`. It sets `is_test_shop` true only when that verify request passes `stagingDoorOpen` and the pending row is `stg-` plus `@staging.invalid`. A body field such as `isTestShop` does not set the column. The fresh owner is stored with `mustChangePassword` true. The audit `staging.fresh_shop_created` names the new tenant id. `POST /api/auth/login` stays `403 code_required` for that email. `POST /api/auth/login/start`, on a staging host and only for an `@staging.invalid` owner of a test shop, returns the real 6-digit sign-in code in the body and does not email it. `POST /api/auth/login/verify` is still required. A live host emails that code and leaves it out of the response. Eight creations from one address in an hour succeed; the next is 429 and stores nothing. That count is in memory for the process. No new env var and no `render.yaml` change. The sign-in page shows Start a fresh shop under the six role buttons only when that door answers enabled. Live renders no such button. The button calls `POST /api/staging/fresh-onboarding`, which holds an invited application (`owner+<id>@staging.invalid`, slug `stg-<8 hex>`, no charter number) and does not email. The browser opens the existing desk setup at `/onboarding/CD-...`, the same page an invite link opens, on Let's open your desk. Finishing it calls `POST /api/onboarding/:ref/launch`. The shop is `is_test_shop` only when that request passes the staging door and the application was minted here. The owner sets their own password on the account screen, so `mustChangePassword` stays false, and the existing owner tour follows on `/app`. The confirm screen shows that 6-digit code in a Staging code chip and hides the resend link. It does not email the code. Live onboarding still emails that code and does not return it. `POST /api/staging/fresh-shop` is unchanged. A test shop is refused by every Stripe call in billing with 403 `TEST_SHOP` and the copy "Test shops can't use billing." Stripe is not called. The founding count and the admin overview leave out `is_test_shop` desks and applications the staging door created. That door row is recognised by `doNotContactReason`, which the public form cannot set. `POST /api/enquiries` drops `stagingFresh`, and the count does not read it. Issue #412.

- **A reversal locks that customer.** Migration 054 defines
  `ledger_lock_watch_customer(tenant, entity, branch, customer)`.
  The function takes a transaction advisory lock on a hash of those
  four values. An insert into `ledger_reversals` calls it for the
  reversed deal's tenant, entity, branch, and customer. A new deal
  does not take the lock. Two reversals for one customer run one
  after the other. The lock ends when that transaction commits or
  rolls back. An acknowledgement shares that legal entity row, then
  calls this function, then reads the watch and inserts.

- **Staging has a one-click sign-in.** `STAGING` must be exactly `1`, and `RENDER_EXTERNAL_HOSTNAME` must be `staging.currencydeskos.com`, `currencydesk-staging.onrender.com`, or `currencydesk-staging-pr-<digits>.onrender.com` with `IS_PULL_REQUEST=true`. `GET /api/staging/signin` and `POST /api/staging/enter` call `stagingDoorOpen` with the request headers, which passes the Host into `isStagingRuntime`, and a missing Host counts as empty. A live host, a missing flag, or a shop other than `tnt-yorkfx` is 404. The enter body is JSON and only a role. The 21st call from one address is refused. The flag is not in `render.yaml`. The session lasts three days. A normal sign-in stays twelve hours and clears the staging marker. The login page shows six Enter as buttons only when the config answers `{enabled:true}`. The banner reads "Staging. Demo data only. Never enter a real customer." It is on the sign-in page while the staging door is open, and it stays up for that session. The demo seed inserts `c.adebayo` (compliance officer) and `l.berg` (auditor) only when `STAGING` is exactly `1`, including on a database that already has the other demo staff. An existing row is not overwritten. If `SEED_PASSWORD` is unset, those two get a random password.

- **The desk snapshot hides an STR from a teller.** `GET /api/tenant/state` returns a suspicious report to administrator, branch manager, and compliance officer. A suspicious report is a submission keyed `STR-`, a basis of structuring, or a kind from the pack's suspicious codes, including SMR. Report history for that filing is treated the same way. The same read returns `ackStr` and `ackStrInfo` to those three plus supervisor. A teller, an auditor, and any other role receive neither. `PUT /api/tenant/state` from a role outside a set leaves the stored report or acknowledgement in place, does not store a new suspicious report, and still saves the other fields. Issue #342.

- **Filing any report is limited to three roles.** `filing:view` opens
  `GET` and `POST /api/ledger/report-filings`. Administrator, branch
  manager, and compliance officer may file any report and may read an STR.
  A supervisor may read an LCTR and may not file any report or read an STR.
  A teller and an auditor get no filing. `GET /api/ledger/transactions`
  keeps the deal and removes the STR tag, the STR link, and the structuring
  fields from a role that cannot see them. The two role sets are
  `shared/str-role.js`. The desk screens are not in this change. Issue #342.

- **The structuring watch is the supervisor and the three STR roles.**
  `GET /api/ledger/transactions` uses one helper, `dealMarks`. That helper
  runs the watch query only when `canSeeStructuringWatch` is true. A teller
  and an auditor get none of the watch fields, and the query does not run.
  A supervisor sees the watch fields and not the STR fields.
  `GET /api/ledger/structuring-watch` and
  `POST /api/ledger/structuring-watch/acknowledge` are those four roles.
  A teller is refused before a row is written. Each acknowledgement inserts
  a new row in `ledger_structuring_watch_acks`, stores the session role,
  and stores the deal ids it saw. The customer stays acknowledged only
  while the current watch deals are that set and the ack time is at or
  after the newest of them. Update, delete,
  and truncate are refused by `ledger_append_only`. A customer who is not
  on the watch is refused and nothing is written.
  `canSeeStructuringWatch`, `STR_KEYS`, and `WATCH_KEYS` live in
  `shared/str-role.js`. The desk screens are not gated here. Issue #342.

- **Filings due share one count.** The Compliance header, the Needs filing list, the bell, the RPT tag, and the badges read `openReportables`. A prepared filing counts, including one whose deals are not loaded in this browser. A filed filing counts as zero due, including one that carries a booking-error flag. When the count is above zero, the header number is amber text on the tile. The menu-bar bell badge and the Ledger nav badge use that same amber, with on-ink text. The Ledger Reportable deals figure is amber when any deal is open. The Dashboard tile Reportable deals reads that same list, and its due number is amber on the panel. The Ledger chip reads that same list. The Ledger chip and the Ledger figure say Reportable deals, and that figure is amber on the panel. Issue #335.

- **A reversed deal stays in the LCTR total.** Cash that was received still counts after a later reversal, whenever that reversal posts. The reversal itself is cash paid out and does not count. The one exception is the reason `booking error, cash not received`. Only a role with `transaction:reverse` can set it: supervisor, branch manager, or administrator. A teller is refused and nothing is reversed. That deal is left out of the cluster. The cluster says "left out: booking error, cash not received. Set by {name}, {16 Jun 2026, 4:00 pm}." in 12px mute type. The name is the staff display name. The clock is the branch clock, 12-hour. A reversed deal that still counts shows a reversed tag on its row. A booking error on a deal already in a prepared or filed LCTR drops that deal from the live total. The filing row stays as it was. A prepared filing shows "A deal in this report was later marked booking error. Check the report before you file it." A filed filing shows "A deal in this report was later marked booking error. Check if the filed report needs a correction." Each booking-error deal is its own flag row, naming who set it and the branch clock. The sentence follows the filing's current status. Deleting a draft filing removes its flags. A filed report cannot be deleted: `ledger_filing_sealed` raises `filed report is sealed`. Issue #327. No reason, or any other reason, still counts. A sealed filing is not deleted. The left-out line still shows when dropping that deal leaves no cluster. The same rule is `shared/lctr-reversal.js`, used by the identity gate and by the desk cluster. Issue #319.

- **A large cash total is the rolling 24 hours before the deal.** The desk clusters and the s.84 identity gate share `shared/rolling-24h.js`. The lookback is elapsed time. It does not reset at midnight. A stored `aggWindowStart` is not applied and is not rewritten. The desk reads the civil date and the time on the branch clock (`branches.timezone`, America/Toronto when the branch has none). The gate reads the deal instant. Two cash receipts that fall inside those 24 hours are one total, including a pair that straddles midnight. A receipt exactly 24 hours earlier counts. One millisecond earlier does not. Exactly CAD 10,000.00 counts. CAD 9,999.99 does not. The settings row reads "Rolling 24 hours" for every role. A stored aggregation hour count does not change an LCTR. The 12h, 24h, 48h, and 72h control is not on a Canada desk. The structuring watch is a separate count of days. Issue #280.

- **The public pages use that same rolling 24 hours.** The home Canada card, the compliance page, and the FAQ say cash received is added over the rolling 24 hours before each deal, and the total does not reset at midnight. The claims check rejects a midnight reset, a 12:00 am reset, a singular calendar day, and each day next to a reset or an aggregation, on every `web/*.html` page and on the in-app help in `os-src` and `web/app/os.js`. A filing deadline of 15 calendar days stays. The small label under a public rule is 12px in the mute ink, which clears 4.5 to 1 on the white card. The marketing pages have no dark theme. "SMR within 24 hours" stays. That is a suspicion deadline, not the cash total. Issue #290.

- **A cheque reversal puts the cash back only in the till that paid it out.** `POST /api/ledger/cheques/:chequeId/reversal` from any other till is 422 `CHEQUE_REVERSAL_WRONG_TILL`, "Reverse this cheque at the till that paid it out. Nothing was reversed." The cheque stays held. No reversal row, no reversal journal, no till movement, and no idempotency row is committed. The same open till still reverses: the net returns to that drawer and the fee is reversed with it. A reversal or a return on a closed or signed-off day is 422 `CHEQUE_DAY_CLOSED` and writes nothing. The cheque detail shows that sentence in the held-cheque state alert and disables Return NSF, Flag fraud and Reverse cashing. The next step comes from `shared/cheque-day-closed.js` on the 422. A return says "Open a new session on the till that paid this cheque out. Then post the return there." A reversal says "Open a new session on the till that paid this cheque out. A supervisor or manager then posts the reversal there." Both also say "The closed day stays as it was." That line is `stays` on the same 422, from the same file.

- **A reversal counts on the day it posts.** `GET /api/ledger/summary` keeps the original deal on the day it was posted, including after that day is closed and signed off. The reversal row is dated when it posts and links to that deal. The later day shows it as its own negative line: volume, fees, realized margin, and the cash, which comes back into the till. A reversal in the same window still leaves that window's money absent, and the void count stays. A cheque return is not a reversal. It does not rewrite the cashing day, and the face is not cash in. The browser renders this summary. It does not keep a second copy of the date rule.

- **The server prices every cashed cheque.** The fee is the saved `cdos_cheque_schedule_v1` row for that type: the greater of the percent of the face and the minimum, half up to the cent. No saved schedule, a null, a blank, or an empty list uses `DEFAULT_CHEQUE_SCHEDULE`, the same list migration 045 writes. A type that schedule does not name is 422 `CHEQUE_TYPE_UNPRICED`: "Nothing was cashed. This cheque type has no fee on the schedule. The owner or a manager can add it in Cheques, Fee schedule." Nothing is written. The fee in the request is not the price. A schedule an owner or a manager saved at 0% still books 0.00.

- **The till summary counts cash that moved.** `cashLegs` in `shared/counter-cash.js` is the rule for the Cash drawer movement card and for large-cash aggregation. A leg counts as cash unless its instrument, trimmed and in lower case, is `cheque`, `electronic_funds_transfer`, `bank_credit`, `money_order`, `bill_credit`, `eft`, `wire`, `draft`, `card`, or `virtual_currency`. That one map is cash in and cash out, so a payout by `money_order` or `bill_credit` is not cash out. `cash`, `none`, a blank, a missing instrument, an unknown name, and a misspelling count the full amount. 12,000.00 received by `electronic_funds_transfer` is not cash and is not a large-cash report. Cash paid out does not count toward that report. Cash taken to issue a money order is #287. The virtual-currency report is #288. A Mixed option, a split pay-in, and the 24 hour window are separate tickets. Cash paid to the customer on a cashed cheque is cash out. The face is not cash in when the instrument is `cheque`. A 1,000.00 cheque cashed for 965.00 beside a 100.00 cash exchange shows CAD in 100.00 and CAD out 965.00. Exactly 10,000.00 CAD cash is the large-cash line. 9,999.99 is under it. Pay-in volume still includes the face. The drawer expected at close is the till balance, which already moved only by the cash paid out.

- **The customer card, the posted deal, and the till payout are one figure.** `calculateQuoteTerms` is the price: `(1/mid) x (1 - margin)`, mid unrounded. On the seed board, 1,000.00 CAD pays 722.10 USD at `0.722103704355`. The card shows that frozen quote. The rate on screen is six places (0.722104) from the shared formatter. The ledger keeps 0.722103704355 for the maths. Before the freeze, `POST /api/quotes/preview` runs the same terms and writes nothing. The old `crossRate` four-decimal rounding is gone. A yen payout is whole units. A remittance face in a three-decimal currency stays at two places. A typed override, and a held text rate, are sent to the server. They are not priced in the browser.

- **Identity verification settings are per shop, and off.** `idv_shop_config` (migration 050) stores the shop id, the provider (default `persona`), an API key reference name, a template id, retention in days, and whether checks are enabled. The flag defaults to false. A shop with no row is off. `GET` and `PUT /api/settings/idv` are the owner's. The shop is the legal entity on the session. A shop id in the query or the body is ignored. The API key field stores the name `PERSONA_API_KEY` or `PERSONA_API_KEY_<SHOP>`, where `<SHOP>` is this shop's site handle, or its name, in capitals, digits, and underscores. Any other name is 400. A value that looks like a key is 400, the reply says to send a name, and the value is not stored, logged, or repeated. GET and the save reply return that name. A field left out of PUT stays as stored. Null clears the key name, the template, and the retention. Null does not clear the checks flag. A wrong type or an unknown field is 400 and does not change the row. A rule failure, such as retention or the template, is 422 and does not change the row. `shopId` is allowed and ignored. Provider-specific field rules live under `server/src/idv/providers/`. 049 is the inquiry-to-shop map, already on main. This change does not alter that webhook.

- **A teller can start a sandbox identity check for their own shop.** `POST /api/idv/start-check` uses the signed-in shop, branch, and teller. A shop id in the body is ignored. The route runs only when that shop's `idv_shop_config.checks_enabled` is true (migration 050, stacked on #267). The shop config names the provider. The route calls that provider's `startCheck` and does not name provider env vars. The Persona adapter reads the env var named by this shop's `apiKeyRef`, or `PERSONA_API_KEY` when that name is empty, and uses the template id on the shop row. The name has to be on the allowlist. If it is not, or the value or the template is missing, the route answers that identity checks are not connected and does not reserve a slot. A per-shop advisory lock reserves the slot before that call. The `reference_id` is random. The inquiry row is written before the provider call. A shop at the in-progress cap (5) is refused. The provider call retries 429 and 5xx three times and does not queue. No images and no provider personal data are stored. `inquiry.created` and `inquiry.started` set the inquiry to in progress. `inquiry.marked-for-review` sets needs review, which is not a pass, and the deal is not released. This route does not reserve a credit, and `reportKycUsage` is not called. Migration 051 adds `idv_inquiries.status`. The webhook adapter and migration 049 are on main.

- **Identity-check credits are an append-only ledger.** `idv_credit_ledger` (migration 052) stores a grant, a reserve, a settle, or a release. The balance is the sum of the amounts. A grant is a whole number above 0 and has no inquiry. The service refuses one above 1000, and the table check rejects zero, a negative amount, or a fraction. A reserve holds 1 credit and is refused when the balance is 0. A settle records a completed pass or decline, leaves that 1 credit spent, and is refused unless that shop reserved the inquiry. A release returns the reserved credit for an abandoned, failed, or expired check. Settle and release cannot both exist for one inquiry. A second reserve, settle, or release for the same inquiry returns the same result and writes no row. Update, delete, and truncate all raise. `POST /api/idv/credits` is a platform administrator, and only when `IDV_CREDIT_SANDBOX` is `1`. A shop administrator receives 403. A grant above 1000 receives 400. No purchase and no payment. `GET /api/idv/credits` is the shop owner, for that shop's own balance and entries. Both routes use the caller's shop. This is not connected to a start-check route, a webhook, or the Stripe meter. 049, 050, and 051 are on main, so this file is 052.

- **Posting a quote returns the quote connection before the deal checks one out.** The quote check commits first. The deal is still its own serializable transaction: frozen terms, the idempotency row, and the journal commit together, and a replay of that post returns the same deal. The quote connection is back in the pool before that transaction starts, so a full pool of posts no longer waits forever for a second connection. A single post after that burst gets a connection.

- **The desk has one clock.** Times and the branch civil day are read in `os-src/cdos-desk-time.js`. `deskTime` prints 3:43 pm on a 12-hour desk and 15:43 on a 24-hour desk. `deskDay` is the civil date in the branch zone, so a Toronto evening is still the previous day when UTC has turned, and a Jerusalem minute after UTC midnight is already the next day. The menubar, the ledger date column, the records list, the deal detail, the live activity line, and the Generated stamp call that module. A stored row keeps a 24-hour HH:MM so sorts stay put, and the screen turns it back through the same clock. Issue #161 item 2 (the desktop clock) and issue #240 item 3 (ledger times such as 4:25 am) are this clock. Light faint and mute are #666666, so the ledger time clears 4.5:1 on white, on the page background, on the desk, on the warning card, and on the hover overlays. Dark faint is #aea89f, so the night ledger time clears 4.5:1 on the night panel. The till session lines and the end of day count cells stay with the open till work. The deal screen's own clocks stay with the open quote and currency work.

- **A till's business date is the branch's civil day.** Opening a till and handing it over stamp `branches.timezone`. The process zone is not that day. With the server on UTC, a till opened at 00:05 IDT is the Jerusalem day, and one opened at 11:55 pm in Toronto is still the Toronto day. Reports, the till end-of-day sheet, and the dashboard turn that date into a window at midnight in `branches.timezone`, which the till session carries. A browser in another zone still asks for the branch's day, so a manager in Israel reading a Toronto till sees that till's deals. A cheque reference and a hold date read the same session day. A database with no branches table still opens: the zone is read on the open transaction's own connection, inside a savepoint, and falls back to America/Toronto. A CD- deal reference, and an obligation reference, take that same civil day, read on the posting transaction. 00:04 IDT on 21 Oct is CD-261021.

- **A second teller takes over a till by counting it.** Opening a till that is already open leaves the holder as they were. The incoming teller counts every ledger currency without seeing the book amounts, and `POST /api/ledger/till-sessions/handover` closes the old session on that count and opens a new one in their name. The variance stays on the old session. The audit row `till.session.handover` names who handed it over. A mid-day count by anyone else is still 409 `TILL_HELD`, and the body includes `holderName`, the same display name as the sentence. The deal form shows Take over this till. A till label says · you only when the ledger roster says this person holds that open session. A station list with no roster shows no · you and no · yours. Issue #422.

- **A cash move that loses the idempotency race reads the winner on its own connection.** The losing transaction is rolled back and wrote nothing. The replay used to check out a second connection while that one was still held. It now reads the stored movement on the same connection. The same body returns that movement. A different body is still refused. One key is still one movement.

- **A cross receipt names both currencies.** When neither side is the home currency, the receipt Pricing line says "We bought INR, sold USD", and the deal row and the ledger Priced row say "Bought INR, sold USD". USD paid in and INR paid out reverses both sentences. A pair that includes the home currency still says "We bought USD" or "We sold USD" on the receipt and the Priced row, and "Bought USD" or "Sold USD" on the deal row.

- **A serialization retry doubles its wait, then spreads it.** Six attempts. The wait is 25ms, then 50, then 100, and so on, plus a spread as wide as that wait. After the sixth abort every route answers with one sentence: "The ledger is busy. Nothing was saved. Please try again." The database code on that error is still 40001, so the route answers LEDGER_BUSY.

- **An INR sell for USD posts.** On a CAD desk the teller pays in INR and pays out USD. Neither side is the home currency, so the deal is a cross. The desk was sending `customer_sell_foreign` whenever the currency paid in was not home, and the server answered 400, "Transaction direction does not match the currency pair." The server rule is unchanged: home paid in is `customer_buy_foreign`, home paid out is `customer_sell_foreign`, and neither side home is `customer_cross`. The desk now sends that same direction.

- **The menubar clock follows the desk's time format and timezone.** Settings → Time format defaults to 12-hour. The header was a hard-coded 24-hour clock, so 16:05 stayed 16:05. It now uses the same clock as the Audit Trail (`deskTime`). With 12-hour set, 16:05 reads 4:05 pm. With 24-hour set, it stays 16:05. The hour is `settings.timezone` (America/Toronto unless the desk changed it), the zone the localization screen stores, not the browser zone. A stored zone Intl cannot read falls back to the browser zone, then UTC, the same order as the filing offset, so the menubar stays up. The time box is the widest reading for that mode: `12:45 pm` on a 12-hour desk, `23:59` on a 24-hour desk. 9:59 am and 12:45 pm are the same width, and a 24-hour desk is the width of its own time. At 430px and below, the phone header replaces the menubar and that header has no clock.

- **A few sentences no longer use an em dash.** Branch Network says "Drag someone onto a branch to assign them, or onto a till to post them to that drawer." A password the employee set reads "Password set by the employee. Only they know it. Reset issues a new temporary one." When the desk cannot reach the server it says "Server unavailable. Passwords are managed on the live desk." An empty name says "Type their name above. Their username fills in by itself." The Visit title is "Visit Us | Currency Exchange at 69 Yorkville Ave, Toronto | York Foreign Exchange". The description says "Unit 102, footsteps from the Four Seasons Hotel". The lede says "69 Yorkville Avenue, Unit 102, directly across from the Four Seasons Hotel". Getting here says Bloor-Yonge. The quote text and the confirm text drop the em dash in their own commit, for compliance review. The confirm clock and the period after a.m. are unchanged. Each file's count of em dashes and en dashes in visible copy must match its baseline exactly. A new dash fails, and dropping one means the baseline is updated in the same change. Settings is 101, including 18 dashes in the business-profile copy from the Desk name line through the compliance fallback. Those 18 sentences are not reworded here. The built desk at web/app/os.js has its own count, 779, with code comments skipped. This merges after the PIN queue.

- **Public quote replies omit the visitor's phone and name.** Creating a quote returns only the ref, the status, the expiry, and the amounts (`from`, `to`, `amount`, `receive`). Confirming returns only the ref, the status, and the expiry. After confirm the Visit page shows "Show ref <ref> at the desk.", the same line for every text status, because create no longer returns the SMS status. The footer says the held rate is honoured at the desk with this ref. The quote card heading, hint, options, buttons, held line, confirmed line, ref line, limit line, error lines, and footer have no em dash and no en dash. The page title is "Visit Us | Currency Exchange at 69 Yorkville Ave, Toronto | York Foreign Exchange". The meta description says "Unit 102, footsteps from the Four Seasons Hotel". The location lede says "Unit 102, directly across from the Four Seasons Hotel". Getting here says Bloor-Yonge. The hours ranges still use an en dash. The quote text says "Ref <ref>. Show this text at the desk." The confirm text says "Ref <ref> confirmed. <amount> set aside until <time>. See you soon." The confirm clock and the period after a.m. are unchanged. The hold time is 12-hour, like "12:22 am". A confirm inside the cleanup minute does not walk the buckets again. The next confirm after that minute does. The confirmation text goes out only on the first confirm. A shop allows 30 confirms a minute, and only a real site is counted. One client address allows 30 confirms a minute, taken from `clientIp`. Over the limit, the reply and the Visit page both say "Too many tries. Wait a minute and try again." A request with no client address gets a plain error, not an internal sentence. Old rate buckets are dropped after their window, and that walk runs at most once a minute. Production presents every request as 127.0.0.1, so that per-IP bucket is shared until loopback handling in `clientIp` changes. The smaller replies are what stop a guessed ref from revealing who asked. The short Q- ref can still be guessed. An unguessable confirm token is a later change and is not in this one.

- **One ID-type catalogue, and no health card numbers.** The types a
  desk can record are one list, `shared/id-document-types.js`. The
  server requires it and the desk loads the same file. Person types:
  Driver's Licence, Passport, Provincial/Territorial Photo ID, Permanent
  Resident Card (PR Card), Citizenship Card, BC Services Card, and
  National Identity Card. The BC Services Card is photo ID, not a
  health card. The National Identity Card is another country's
  government photo ID card, such as an Emirates ID, so a desk outside
  Canada can record its own country's card. Business types:
  Business Number, Incorporation Certificate, Master Business Licence,
  and Articles of Incorporation. A saved type is stored as the
  catalogue names it. Any other type is 422 `ID_TYPE_NOT_IN_CATALOGUE`,
  and the sentence lists the accepted types. A health card is in the
  list so a stored one still reads, and it is never accepted: adding
  one, or changing a type to one, is 422 `HEALTH_CARD_NOT_ID`, "Health
  cards can't be used as ID. Record a current photo ID." A stored
  health card cannot be edited. It can be removed, and a new ID can be
  added beside it. No read returns a health number: the key is absent
  from one client, the list, and lookup. Search does not match it. The
  saved desk document drops it on save, on read, and on a conflict, and
  the desk drops it from this browser's saved copies when it loads. The
  file, the quick card, the editors, and the printed report say "Health
  card — not accepted as ID" with no number. The KYC register and its
  CSV leave the number empty. LCTR and STR identifier fields fill only
  from a type the catalogue accepts. A health card does not make a file
  identified, and the till's counter record for a health card only is
  `missing`. The register and the ledger say "ID on file" where they
  said "verified". Ontario's Health Cards and Numbers Control Act, 1991
  bars a business outside health care from collecting or using a health
  number, and FINTRAC says not to use a health card where provincial
  law prohibits it. The desk refuses them everywhere, which is stricter
  than the law. Stored numbers are not blanked: that is the owner's
  redaction tool, #134. The posting gate is #108. This replaces #157,
  #100, and #131. The owner asked for it during the freeze, on
  2026-10-19. Write-up: `docs/CLIENT_RECORDS.md`.

- **Settings → Accepted IDs, per shop.** The owner switches each
  catalogue ID type on or off for their shop, in Person and Business
  groups. The list is `legal_entities.accepted_id_types` (migration
  047), catalogue codes. NULL follows the jurisdiction pack, and every
  existing desk is NULL. A save that lands on the pack's own list
  stores NULL again. By default every type the catalogue accepts is
  on, in every pack. A pack can lock a type off with a short legal note
  (`server/src/ledger/id-type-rules.ts`, keyed by the pack's
  jurisdiction). The health card is locked in every pack; Canada's note
  says FINTRAC says not to use a health card where provincial law
  forbids it, and that Ontario's Health Cards and Numbers Control Act
  bars it. `GET /api/clients/accepted-id-types` is every role's, with
  `canChange` true only for the owner. `PUT` takes `{ accepted: codes
  | null }` and is the owner's (`compliance:thresholds`): a manager or
  a teller gets 403, "Only the owner can change which IDs this shop
  accepts.", and nothing changes. Switching on a locked type is 422
  `ID_TYPE_LOCKED` with the note. A list with no person photo ID is 422
  `PHOTO_ID_REQUIRED`, "Keep at least one photo ID switched on."
  Business types may all be off. A change writes
  `desk.id_types.change` naming what went on and off and how many IDs
  on file are a type just switched off, never a document number. Adding
  a document of a switched-off type, or changing one to it, is 422
  `ID_TYPE_NOT_ACCEPTED_HERE`, "This shop doesn't accept {label}. The
  owner can change this in Settings → Accepted IDs." Sending a
  document's own type back, and correcting its number or dates, still
  works. "Not stated" still works. `ID_TYPE_NOT_IN_CATALOGUE` now lists
  this shop's accepted types. A document already on file of a
  switched-off type is not deleted or rewritten: it reads in full,
  keeps its verification status and counter record, and carries a
  `notice`, "This shop no longer accepts {label}. Record another ID at
  the next visit.", which the client file shows quietly. Every ID
  picker (client file, quick card, Record the ID, the ledger's quick
  add) offers only this shop's types; a switched-off type on file stays
  visible as the current value and cannot be chosen again. Locked types
  show a padlock and their note and cannot be switched on. A manager
  sees the list read-only with that sentence. A refused save shows the
  server's sentence and does not say Saved. The owner asked for this on
  2026-10-19.

- **A till PIN in the desk snapshot is not a PIN.** `PUT /api/tenant/state` strips pin fields from `cdos_settings.employees` whether that value is an object or the JSON string the desk saves, including a pin nested inside an entry, and a pin key on the document itself, and does not write it onto a staff record. `GET /api/tenant/state` returns a copy with those same keys removed and does not write. A one-off clean of PINs already stored is a separate change. The save still returns 200, and the body includes `pinsIgnored` with how many were dropped, capped at 40. 0000 is the old no-PIN default: it is stripped and never stored, and it is not counted and does not write an audit row. A snapshot that carried a real PIN writes `settings.staff_pin_ignored`. The codes are staff ids on this desk, duplicates removed, then capped at 40. No digits. A teller who names someone else's `staffId` on `POST /api/staff/pin` gets 403 and nothing is written. A manager may set a PIN only for someone below them, on this desk. An administrator may set someone else's PIN. That PIN stays must-change and writes `pin.set`. A person still sets their own through the same route. `POST /api/auth/switch` still needs a server-set PIN: no hash is 409 `no_pin`, and a manager-issued PIN is 409 `must_change` until that person chooses their own.

- **An owner can issue a till PIN from the desk.** Settings, Employees, open a person, Transaction PIN, Issue a new PIN. The screen sends `POST /api/staff/:staffId/pin` with a JSON content type and `{}`. An empty body is still refused. That request issues a 4-digit PIN. It is shown once, and `pinMustChange` is set, so the person changes it the first time they use it. A manager can issue one for somebody they manage. A teller cannot. Nobody issues their own from that button. A failure on the screen is one of a fixed set of sentences. The screen never repeats the server's words. Anything else, including Bad Request, is "The PIN was not issued. Try again." No connection is "No connection. The PIN was not issued." The JSON parser is unchanged. The button is hidden whenever the server would refuse, including someone of the same rank below owner, and for the signed-in person. The screen ranks a compliance officer with the server, at 2. Remove a team member and delete a desk send no content type when they have no body. My account says: Only you know it. Changing it signs out your other devices. Issuing above your role says "You can only issue a PIN for someone below your role." The PIN is for the same three things in both places: take a till, switch accounts, and void a deal. On a phone the title sits above the PIN, with no empty band between them. My account does not say everyone starts at 0000. A manager issues the first PIN, and the person changes it the first time they use it. The server still refuses 0000. The owner asked for this fix during the freeze, on 2026-10-18.

- **An employee row follows rank.** A change to an employee's role or permissions (`caps`, and a `permissions` object on the same entry) is stored only when that employee ranks strictly below the person who is signed in. The numbers are `ROLE_RANK`, the same table PIN issuing uses. Anyone else gets 403, "Only someone senior to this person can change their role or permissions.", and nothing in that save is written. The refusal writes `settings.pin_rule_refused` and the actor is the signed-in person, not a client field named actingUser. Removing a row says "Only someone senior to this person can remove them." Putting a known person back, including a new row that uses that person's code, staff id, or id, is the rank sentence. The same rule applies to the first copy of an empty list: a teller cannot name the owner as Cashier. The owner is the signed-in role administrator and can change their own row and anyone else's. A browser role and `compliance:thresholds` are not that check. A manager may remove a teller. A manager cannot remove the owner or themselves. A row that only carries a PIN is not a role edit, and the snapshot strip still runs.

- **A manager sees the PIN state, not the switches.** Require PIN to switch account, Require PIN to take a till, Require PIN to void a transaction, and Require PIN on a person's page show On or Off in the ink colour. The line under each is "Only the owner can change this." The owner still has the switches.

- **Require PIN is the owner's.** A non-owner who changes an employee's Require PIN, `pinOnSwitch`, `pinOnTill`, `pinOnVoid`, a `pinHash`, or `pinMustChange` gets 403 and nothing is written. Require PIN says "Only the owner can change whether this person needs a PIN." A PIN hash says "Use Issue a new PIN to give someone a new PIN." The switches and whether a PIN must be changed each have their own sentence. That audit is `settings.pin_owner_refused` and the actor is the signed-in person, not a client field named actingUser. The owner is the signed-in role administrator. Holding `compliance:thresholds` does not make a compliance officer the owner: they are refused on a PIN field, on their own row, and on a manager's row. A non-owner who sets `compliance:thresholds` on caps or permissions gets 403, "Only the owner can grant that permission." Sending the same PIN values back still saves. `POST /api/auth/switch` already requires a four digit PIN for every person. The flag does not turn that off. A four digit `pin` in the snapshot is still stripped when the save is allowed.

- **Cheque fees are the owner's or a manager's.** Sol's rule: the owner and a manager may set the fee, including 0%. A teller, a senior teller, a trainee, and an auditor may not. Who may write `cdos_cheque_schedule_v1` is `canWriteSetting`. Today's default allows a branch manager and a compliance officer. The owner is always allowed, so they cannot be locked out. The table is not stored yet and there is no screen for it. A numeric version that is not current is 409 before the fee refusal. Anyone else gets 403: "Only the owner or a manager can change cheque fees. Ask a manager to make this change." A platform row does not take the save away. A teller's document cannot replace the fee key. A save with no version that would change the fee is 409, with no write and no refusal row. The refusal is `settings.cheque_fee_refused`. A save that lands is `settings.cheque_fee_changed`, with who, when, and the old and new price of each cheque type. Every cashing is priced from the saved schedule, or from the default schedule when none is saved. A type that schedule does not name is 422 CHEQUE_TYPE_UNPRICED and nothing is written. The fee in the request is not the price. A saved 0% still books 0.00. The Fee schedule tab is grey, with the lock at the start of that sentence and the sentence wrapped, and no inputs and no Save, for a teller and for a cashier, before any Save. The phone table uses the same card, padding, Fee % column, and sideways scroll as main. Min fee shows two decimals and the example is the body colour, and its header is $2,000.00. A grouped list for the phone is a later change and is not here. The owner and a manager see the table and Save. The header names whoever is signed in now. A refused Save keeps the typed values and shows one amber line above Save. A stale second save shows a conflict line that stays on screen, with darker text, a 44px Reload, and the typed values kept until Reload loads the server schedule and its version. The Risk select is 44px. A save that lands shows Saved. A low-fee notice is not here. The screen and the server price a cheque fee with the same integer-cent half-up helper. Payroll at 2% of 1,000.25 is 20.01. A float multiply prints 20.00. A face of 1,000.5 is the same 20.01. Fee %, a minimum, and a maximum accept at most 2 decimal places on save. More than that is a 400 that names the field, and the schedule is unchanged. A fee % says "That change didn't save. A fee % can have up to 2 decimals, like 2.25." The check reads the number, so 1e-7 is refused and 1e2 is 100. The Fee % field is text. Clearing it and leaving the field restores the saved percent. The table and the edit state show a stored 2.125 as 2.13, the figure booking uses, so saving another row stores 2.13 for that percent. A percent already stored with more places rounds half up to 2 when the fee is read, and the cheque still books. The cheque route books a face of 1000.5 at 2% as 20.01. A figure the helper cannot read is refused on save and at booking, by the same reader, so a schedule that saves can still be priced. An unreadable figure is not booked as 0.00. Min fee "4." tidies to 4.00, and Fee % "." restores the saved percent. The teller sees "Nothing was cashed. The fee for this cheque type can't be read. The owner or a manager can fix it in Cheques, Fee schedule." The places banner is 13px, outlines the field that broke the rule, and sets aria-invalid. The phone table's sideways scroll stays until the grouped-list change.

- **A new person's username has the shop in it.** On the Employees
  screen, typing a name fills Staff ID / username with the first name
  and the shop's handle: amir.yorkfx. The handle is the shop's site
  handle, or its name, letters and digits only. If that is taken, the
  last initial is added (amirs.yorkfx), then a number (amir2.yorkfx).
  The server picks it and checks it against every desk, not only this
  one (`GET /api/staff/username`, `server/src/auth/username.ts`). The
  manager can type a different one. The screen says whether it is free,
  and the create route checks it again: a username another desk holds
  is 409 with the next free one, and one in the shape of a CurrencyDesk
  ID is 400. Once the sign-in exists the username is fixed on the
  screen. A username typed on a profile that already belongs to
  somebody else does not make their account this person's: the profile
  shows no sign-in, and offers no reset, disable, block, or PIN for
  that other account. An account is the profile's once its sign-in was
  created from that profile, or when the profile predates usernames. A person can have a work email on file (`staff_users.email`,
  migration 046). It is a contact, not a sign-in name. Creating a
  sign-in no longer asks the manager for a password. The server issues
  a temporary one and emails it to the work email, with the username
  and the sign-in link. With no work email, the temporary password is
  shown once to be read out. A work email edited after the sign-in
  exists is saved on the server, and the next invitation goes there.
  Before this, a name-style id at any desk but York could not sign in:
  the sign-in screen does not name a desk, and the server looked in
  York. When the caller names no desk, sign-in now looks at York first
  and then on every desk. A caller that names a desk gets that desk
  only. Only a name that exists once signs in, so an older id that two
  desks both hold signs in nowhere. York's older ids, like a.singh, keep
  working. A username sign-in is still password-only; the work email
  does not add an emailed code. Reset password on the screen still
  takes a password the manager types. Forgot password does not use the
  work email yet. The owner authorised this pull request during the
  freeze, on 2026-10-18.

- **Owner-only settings stay with the owner.** Non-owners may change
  an allowlist of desk fields their own screens write (their account,
  the people a sign-in adopts, and the manager's app settings). A
  manager may also change the default spread. Every other field in
  the desk settings (shop, compliance including the large-cash line,
  localization, billing, hours and timezone, role presets, and the
  handoff count) is the owner's. A teller who sends a different
  default spread is refused, audited, and the stored spread is kept.
  A different value on `PUT /api/tenant/state` is 403, an audit row, and
  nothing in that save is written. An equal value, or a key the client
  left out, is not a change: the stored value stays and the rest saves.
  Sign-in does not upload the derived role presets or billing plan.
  A refusal of any other save reloads the stored desk and saving
  continues. Settings search hides the owner-only tabs. The settings
  rail follows the signed-in role, so a manager still sees it after a
  teller has rewritten the shared preset. Rates & fees shows a field
  the person cannot change as a grey value with a lock, before they
  type. The default spread stays editable for a manager and the owner,
  and that row says a manager or the owner can change it. Every other
  price on that screen is the owner's, and the row says only the owner
  can change it. A teller has nothing to edit there, so there is no
  Save. A manager sees one line: only the owner can change most of
  these, and that they can change the default spread. A teller sees
  one line: only the owner can change rates and fees, and to ask the
  owner or a manager. A locked amount shows two decimals. A Rates &
  fees save the server still refuses keeps what was typed, repeats
  that person's line above Save, and does not toast or show an error
  code. The stored
  desk is put back underneath so other saves continue. A manager
  cannot move the threshold.
  `PUT /api/ledger/desk-thresholds` was already limited to the owner.
  Only the owner-only refusal (`forbidden`) reloads and keeps saving.
  A cheque fee refusal still stops the autosave. The Fee schedule Save
  sends what the autosave sends, so a manager's fee save is not refused
  over the role presets.

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
  amount in the rolling 24 hours before the deal, on three axes
  that are not mixed: conducted by, on behalf
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

- **Every desk has a cheque schedule.** Migration 045 writes the default where the desk has none. A stored null, an empty string, `[]`, or a value that is not a non-empty JSON array is missing, and the default is written. A schedule already stored, including 0%, is left byte for byte. Each desk that changes gets one audit row, actor `system migration`, action `cheque.schedule_backfill`, with the value before and the value after. A second run writes none. Signup, onboarding, an admin creating a desk, the platform tenant, and the York FX seed write that same default when the desk is created, and they do not replace a schedule that is already there. A boot that fills a missing schedule writes one audit row, actor `system seed`, action `cheque.schedule_backfill`, with the value before and the value after. A boot that finds a schedule already stored writes none. A browser opens the desk as new only when `cdos_settings` is missing and there are no rows and no clients. A blank `cdos_settings` is missing. The schedule and a tour flag do not count as records. It writes the shop name and the empty cash, keeps the stored keys, and leaves the rate board in place. A desk that has rows, clients, or a saved `cdos_settings` opens as the saved desk, so those records are not replaced with empty.

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
error: "database" }` when that read fails. A reachable database also
returns `commit` (the first 7 characters of `RENDER_GIT_COMMIT`, or
`unknown` when that variable is unset) and `lastMigration` (the id of
the newest applied row in `schema_migrations`, or null when that read
fails, including a connect failure, or Postgres cancels it). The Postgres read sets `statement_timeout`
to 1000 ms, so the server cancels it and frees the connection. PGlite
stops waiting after 1 second in the process. The tenant read on this
route is unchanged. When the database is not
reachable, `lastMigration` is null and `ok` stays false. Render `healthCheckPath` still points at `/api/health`.
The migration runner logs `opening database` before its first query and
`migration applied: <id>` for each migration it applies. A second run
logs no applied line. Free-tier sleep after idle is unchanged. That is
a hosting step, not this probe. `/api/admin/health` remains the
authenticated narrative dashboard.

## Next engineering priorities (ordered)

1. client shows Set your till PIN in Settings when pinsIgnored > 0
2. The Shop-Ready Core walkthrough — prove the milestone loop end to end.
   The operator file folder is no longer the gap in that loop: opening a
   client shows the papers filed for them, searchable, from the database,
   and where they stand (`unverified` / `identified` / `expired` /
   `verified`). The identification and large-cash lines stay the pack's.
   The platform desk tile counts those customers and that standing from
   `desk_clients`, not from the browser blob.

## Last reviewed

**2026-10-26**, public health names the deploy. `GET /api/health` still answers from the tenant read: 200 when it works, 503 `{ ok: false, error: "database" }` when it does not. The body adds `commit` and `lastMigration`. `commit` is the first 7 characters of `RENDER_GIT_COMMIT`, or `unknown` when unset. `lastMigration` is the newest applied id in `schema_migrations`, or null when that read fails, including a connect failure, Postgres cancels it, or the database is down. On Postgres the read sets `statement_timeout` to 1000 ms so the server cancels it and frees the connection. PGlite stops waiting after 1 second in the process. The tenant read on this route is unchanged. `runMigrations` logs `opening database` before its first query and one `migration applied: <id>` line each time it applies a migration. A second run logs no applied line. No migration was added.

**2026-10-24**, per-shop identity verification settings. Migration 050 adds `idv_shop_config`. The provider column defaults to `persona`. The owner reads and writes `/api/settings/idv`. The shop comes from the session. The API key field accepts only `PERSONA_API_KEY` or `PERSONA_API_KEY_<SHOP>`. A field left out of PUT stays as stored. A wrong type or an unknown field is 400 and does not change the row. Checks default to off. 049 is the inquiry map. 050 follows it.

**2026-10-24**, sandbox identity start. `POST /api/idv/start-check` is the caller's shop only. Checks stay off until `idv_shop_config` says otherwise. The route calls the registry provider. An empty key name uses `PERSONA_API_KEY`. A missing template or env value answers not connected. A per-shop advisory lock keeps the in-progress cap under parallel starts. Migration 051 adds inquiry status. This route does not reserve a credit. The credit ledger is migration 052 and is not connected to this route. This stacks on #267. 049 is on main. 050 is the shop config.

**2026-10-20**, saved till variance. A count leaves `ledger_till_balances.available_amount` as the ledger stored it. The variance on a new `ledger_till_counts` row is the counted amount minus `roundTo` of that expected. `roundTo` is the one rounding rule: half up, by the currency's minor units, the same function the ledger and receipts use. 489,176 against a stored 489,175.85 yen saves 0. 489,177 saves 1. 489,175 saves -1. Half a minor unit rounds up, so 100.50 yen counts as 101. The gap between the stored figure and `roundTo` of it is always less than one minor unit. A two-decimal currency is unchanged, so 100.00 CAD against 99.85 saves 0.15. KWD stays at three places in `roundTo`, and a KWD count is still refused because the ledger stores two places. A new count row gains `stored_expected_amount`, the unrounded expected next to that variance, and the till session exports it with the count. Older rows keep that column NULL. Nothing backfills them, nothing writes 0, and their saved variance is not recalculated. On the end-of-day sign-off, a row saved before the column shows the expected exactly as it was saved in the drawer column, in the same ink as the other drawer figures. The variance column shows only the saved difference. 100 against 99.85 yen reads 99.85 in the drawer and +0.15 in the variance, and Counted stays 100. That +0.15 is the same variance as the CSV and the database. A close and a handover save the same signs as an interim count: 489,177 is +1 and 489,175 is -1. The grey line says: Counted before whole-yen display. Variance shown as saved then. The total uses that saved variance and names its currency, so +0.15 JPY does not read as 0.15 CAD, and it does not read balanced. A row that stored its expected still shows the whole-unit difference. The count row is append-only, so the field cannot be updated. A close and a handover save the same rounded variance as a count. This is not the true-up. The drawer balance keeps the fraction.

**2026-10-20**, cross deal words. Neither side home reads "We bought INR, sold USD" on the receipt and "Bought INR, sold USD" on the deal row and the ledger Priced row. The reverse pair names USD first. A home pair still reads "We bought USD" or "We sold USD".

**2026-10-20**, INR sold for USD. The desk direction follows the currencies and the home currency. A CAD desk selling INR for USD sends `customer_cross`. A pair with the home currency paid out still sends `customer_sell_foreign`. A pair with the home currency paid in still sends `customer_buy_foreign`. The server check is the same rule it already enforced.

**2026-10-20**, small rates and the board field. A rate below 0.001 keeps four significant digits, so 1,000,000.00 to 725.40 shows `0.0007254`, and 1,000,000.00 to 98.50 shows `0.0000985` rather than `0.0001`. The sheet, the receipt, the deal detail, and the customer quote use that figure. The note follows only when it was rounded. pinNote clears 4.5:1 on the sheet, and the receipt is a paper island so that light token stays on white paper. The ticket uses noteOnInk, which clears 4.5:1 on the ink. The Board rate field and Override keep the computed figure: `0.00098` stays `0.00098`. An unmapped quote error is the plain sentence, not the server text. Amount minor units still follow the two-place amount line until #233.

**2026-10-19**, rate on the sheet. Head of Design settled the rule. The payout is the figure of record. The sheet, the summary, the receipt, and the booked deal show the rate that payout came from. It always shows at least four places. It shows five or six only when that rate times the amount equals the payout with nothing left over. Otherwise it shows four places and the note "Rate rounded. The amounts are exact." The note is small and grey under the rate on the sheet, one line on the receipt, and it appears only when the rate was rounded. The board rate is not the figure next to a payout. The editable field is labeled Board rate and keeps its precision. A quote the board cannot price, a direction that does not match the currencies, and a negative spread are cashier sentences. The raw words `negative spread` and `direction and currencies disagree` do not reach the screen. 100.00 to 10825 at zero places is `108.2500` with no note. On the desk, 1,234.5 INR stays one decimal, and 100 INR to 1.18 USD shows `1 INR = 0.0118 USD` at four places. 3,000.00 CAD to 2,166.31 USD shows `1 CAD = 0.7221 USD` and the note.

**2026-10-20**, yen and won on the screen. The screen reads places from the server `scales` table once the desk has loaded it. Before that load, and if it fails, the screen uses the ISO minor units, so `fmt(200, 'CAD')` is `$200.00` and yen is already whole units. A code the table does not name is 2 places. Three-decimal scales are shown at three, so 1.235 dinars reads 1.235. The ledger still stores two and still refuses to book a three-place currency. `storedText` keeps extra stored digits. `unitText` does not: a new payout, and the till's expected figure, show 99.85 yen as 100. The cash variance is counted minus that whole-unit expected, so 489,176 against a stored 489,175.85 yen reads balanced, and 489,177 reads +1 over. 100 against 99.5 yen is balanced, because both whole-unit figures are 100. When the stored expected is off the grid, one grey line under Expected names the stored figure, and the counted home amount sits on that Expected line. The same line is on the count. On the reconcile and on the end-of-day sign-off the line is a full-width row under the currency. Below 600px the reconcile table is replaced by the phone close: Close the till, a Count, Check, Close bar, one grouped row per currency, and a Close the day dock pinned above the tab bar. An uncounted row has a Count button. A counted row says You counted, the figure, Expected, and a chip (Matches, or the unit over or short). The unit word is the last word of the currency name. Yen, won, yuan, baht and rand stay unpluralised. Danish and Norwegian krone pluralise as kroner, Swedish krona as kronor, and Brazilian real as reais. Kuwaiti dinar reads dinar. Until every currency is counted the total stays a hint, Count every currency to see your total, and the dock is disabled. Once they are, the total shows Expected, Counted and Difference. The phone colours are the mockup colours, including #5E5E63, and not the app mute grey. From 600px up the table stays. Its close reads Close day and lock book, and the expected total keeps two CAD places, so this drawer reads 5,451.60. The counted total adds the home amounts and rounds once, so a yen-only count reads 4,451.11. An empty last count reads Never. The dock background runs down to the tab bar, and 12px of that white sits under the caption. The wide heading reads Reconcile and close, day 1. The heading stays clear of the operator strip. On a phone the sign-off line wraps inside the visible card, and the stored figure stays one unbroken number. That line is pinNote, which clears 4.5:1 on the white panel. 1,000.50 CAD has no line. The book still stores the fraction. This is the screen half of the minor-unit split. It edits `cdos-till.jsx` and `cdos-reports.jsx`.

**2026-10-19**, yen and won. A new payout is rounded half up to the currency's own minor units, from the table already in `server/src/ledger/currencies.ts` (`roundTo`). JPY and KRW are whole units on the quote, the booking, and the receipt. `10000.55` JPY is refused with a sentence that says yen has no minor unit. A stored `10781.00` still posts, because the money columns read back two places. A closed day shows stored units as stored, so `200.80` yen stays `200.80`. An open day rounds each row and then adds, so `100.40` and `100.40` total `200.00`. The till expected figure is the stored balance. A count of `100` against `99.85` yen used to save a variance of `0.15`. The saved variance now follows `roundTo`, in the 2026-10-20 saved till variance note. KWD and BHD keep three places in `roundTo`. The ledger still does not store a three-decimal currency on an exchange. A remittance face amount in JOD, KWD, BHD, OMR, IQD, TND, or LYD still posts at two decimal places, and a third decimal is refused. This removes the fake yen variance from draft #137. It does not fix the rest of that draft: counts that change what the cashier typed, the raw 500 on a bad count, the fake 1-to-1 CAD value, or the KWD wording. The figures that screen draws from this book change: an open day's units sold goes from 200.80 to 200.00, and that same total is what the report CSV and the vault list show. The summary returns cash drawer movement on the same open-day rule: two open-day payouts of 100.40 yen are Paid out 200, and two open-day receipts of 100.40 yen are Received 200. Net position is -200 when only the payouts are in the window. The period summary CSV does not export that table. A yen remittance receipt no longer ends in .00. The Transfers detail and its printed receipt show the ledger receipt lines, grouped with the desk's own number format, so a whole yen payout reads 10,825 JPY rather than 10825 or 10825.00 JPY. Customer pays on that detail and on the printed receipt reads 100.00 CAD. The printed rate reads 108.25 JPY/CAD. The Ledger receipt label uses pinNote, which clears 4.5:1. The status timeline uses the desk clock, so a 12-hour desk reads 09:00 as 9:00 am. The cash drawer table draws the summary's movement cell by cell, so an open day of two 100.40 yen payouts reads 0 in, 200 out, and Net -200 rather than 200.8. A CAD row on the same table keeps two decimals, so that day reads 200.00 in, 0.00 out, and +200.00 net. The headers are In, Out, and Net, and one caption in pinNote says what they are. That caption clears 4.5:1.

**2026-10-19**, test isolation. The document-reads suite's last case leaves York FX on the British pack, and the report-filings suite's last case does the same. Each file puts the seed pack back (`CAD`, `pack-ca-v1`) before it ends, then reads the York FX desk and requires CAD and `pack-ca-v1`. No cheque source changes.

**2026-10-19**, menubar clock. The header uses the Audit Trail clock, in `settings.timezone`. A 12-hour desk reads 16:05 as 4:05 pm. A 24-hour desk still reads 16:05. The 12-hour box is the width of `12:45 pm`. The 24-hour box is the width of `23:59`. A stored zone the clock cannot read falls back to the browser zone, then UTC, and the menubar still shows a time.

**2026-10-19**, a few em dashes. Branch Network says "Drag someone onto a branch to assign them, or onto a till to post them to that drawer." The employee password line is unchanged from the period form. The offline line and the empty-name line use a period. The Visit title uses a vertical bar, the description says "Unit 102, footsteps", and the lede keeps one sentence through "directly across". Getting here says Bloor-Yonge. The quote text and the confirm text drop the em dash in their own commit. The confirm clock and the period after a.m. are unchanged. Each file's count must match its baseline exactly. Settings is 101, including 18 dashes in the business-profile copy that are not reworded here. web/app/os.js is 779.

**2026-10-19**, plan changes in the Stripe portal. The plan on a subscription is read from its price; the `currencydesk_plan` label stamped at checkout is only a fallback, because it is stale after a portal upgrade or downgrade. A paid invoice sets the shop's plan from the price it charged for (the positive line), so it no longer depends on `customer.subscription.updated` arriving first. A subscription update that is `active` (or `trialing`) with no `pending_update` also sets the shop's plan: the portal does not move the price until an upgrade is paid.

**2026-10-19**, subscriptions in US dollars. Every plan is billed in USD: Rates US$299, Full System US$599 and AI Bundle US$749 a month, with annual at 10% off, all tax-exclusive. `render.yaml` names the six live USD price IDs. The Billing & plan screen and its invoice show USD, and the site FAQ says US$. The live Stripe key and webhook secret are set in Render.

**2026-10-19**, PIN switches. A manager sees On or Off in the ink colour for switch, till, void, and a person's Require PIN. The note is "Only the owner can change this." The owner still has the switches.

**2026-10-19**, Require PIN. A non-owner who changes Require PIN, a PIN switch, a PIN hash, or pinMustChange gets 403. The audit `settings.pin_owner_refused` names the session, not a client actingUser. The owner is the signed-in role administrator. A compliance officer who holds compliance:thresholds is still refused. Granting that permission is the owner's. Switch still asks for a PIN when the flag is off.

**2026-10-19**, employee rank. A role or permissions change, a removed row, a known person put back, and the first copy of an empty list are the same edit. The actor has to rank strictly above that person, using `ROLE_RANK`. The owner is the signed-in role administrator and is not locked out. The audit is `settings.pin_rule_refused` and names the session. A PIN-only row is not this edit.

**2026-10-19**, Settings → Accepted IDs. The owner switches catalogue ID types on and off per shop; NULL follows the pack, and every type the catalogue accepts is on by default in every pack. Packs lock types in code (`server/src/ledger/id-type-rules.ts`); the health card is locked everywhere, with Canada's FINTRAC and Ontario note. The route is every role's to read and the owner's to change; a locked type and a list with no photo ID are 422, and a change is an audit row with no document number. A switched-off type is refused on add and on change (`ID_TYPE_NOT_ACCEPTED_HERE`); one already on file reads in full with its status and a quiet notice. The pickers follow the list. Migration 047. 041 is still claimed by open draft #132, 042 by #130, and 043 by #138.

**2026-10-19**, ID-type catalogue and health cards. One list, `shared/id-document-types.js`, loaded by the server and by the desk. A type outside it is 422 `ID_TYPE_NOT_IN_CATALOGUE`. A health card is 422 `HEALTH_CARD_NOT_ID`, "Health cards can't be used as ID. Record a current photo ID." The BC Services Card is accepted. A health number is not in any client read, search, report, register, CSV, LCTR or STR field, or the saved desk document. It does not identify a file. Stored rows are not rewritten and stored numbers are not blanked. No migration.

**2026-10-18**, names and comments. Every tracked file name was checked against CONTRIBUTING, and every comment and doc line against the code. Statements the code contradicts were corrected; nothing that could not be shown wrong was changed. `server/src/state/defaultChequeSchedule.ts` is `default-cheque-schedule.ts`. `tenantState.ts` and `settingsWrite.ts` keep their names until the open pull requests that edit or import them have landed. The desk no longer carries an uncalled function that made up an address and an ID number from a name. The Cross-Border EFT report no longer says transfers do not post; it says the page is built from the Transfers app's own records. The owner ended the PR freeze.

**2026-10-19**, till PIN in the desk snapshot. A pin field on an employee in `PUT /api/tenant/state`, and a pin key on the document itself, is stripped from the object form and from the JSON string the desk saves and never stored on the staff record. `GET /api/tenant/state` returns a copy with those keys removed and does not write. Cleaning PINs already stored is a separate change. 0000 is the old no-PIN default, so it is stripped and not counted, and it does not write an audit row. The response includes `pinsIgnored`, capped at 40. The audit row `settings.staff_pin_ignored` names staff ids on this desk after duplicates are removed, then caps that list at 40. A teller naming another `staffId` on `POST /api/staff/pin` is 403 with no write. A manager cannot set an administrator's PIN, another manager's PIN, or a PIN on another desk. An administrator may set someone else's PIN, must-change, with a `pin.set` row. A weak PIN on that path is 422. Follow-up: client shows Set your till PIN in Settings when pinsIgnored > 0.

**2026-10-18**, issuing a till PIN. Issue a new PIN on an employee profile sends `{}`, and the server issues one. An empty JSON body is still refused. The JSON parser is unchanged. The button is hidden whenever the server would refuse, including someone of the same rank below owner, and for the signed-in person. The screen ranks a compliance officer with the server, at 2. A failure on the screen is one of a fixed set of sentences. The screen never repeats the server's words. Anything else, including Bad Request, is "The PIN was not issued. Try again." No connection is "No connection. The PIN was not issued." Remove a team member and delete a desk send no content type when they have no body. The PIN is shown once and must be changed on first use. A manager can issue one for someone they manage. A teller cannot. My account says a manager issues the first PIN and the person changes it the first time they use it. The password line says: Only you know it. Changing it signs out your other devices. It does not say everyone starts at 0000. The server still refuses 0000. Issuing above your role says "You can only issue a PIN for someone below your role." The PIN line is the same in both places: take a till, switch accounts, and void a deal. On a phone the title sits above the PIN. The owner asked for this fix during the freeze.

**2026-10-18**, usernames and the work email. A new username is the first name and the shop handle, picked by the server and free on every desk. A taken one is 409 with the next free one; a CurrencyDesk-ID shape is 400. Creating a sign-in emails a temporary password to the work email with the username and the link, or shows it once when there is no address. Sign-in that names no desk finds a username on any desk when exactly one desk holds it; one that names a desk stays there. Migration 046. 041 is claimed by open draft #132, 042 by #130, and 043 by #138.

**2026-10-17**, cheque fees. The owner and a manager can change the cheque fee schedule, including to 0%. A teller, a senior teller, a trainee, and an auditor cannot. Who may write it is `canWriteSetting`. Today's default allows a branch manager and a compliance officer, and the owner is always allowed. That table is not stored and has no screen. A stale numeric version is 409 before the fee refusal. A platform row does not remove the save. A teller's document cannot replace the fee key. A refusal is 403, the stored schedule is unchanged, and the audit action is `settings.cheque_fee_refused`. A save that lands writes `settings.cheque_fee_changed` with who, when, and the old and new price of each type. Every cashing is priced from the saved schedule, or from the default schedule when none is saved. A type that schedule does not name is 422 CHEQUE_TYPE_UNPRICED and nothing is written. The fee in the request is not the price. A saved 0% still books 0.00. The Fee schedule tab is read-only for a teller and for a cashier, with no inputs before any Save, the sentence wraps, and the phone table uses the same card, padding, Fee % column, and sideways scroll as main. Min fee shows two decimals, the example is the body colour, and its header is $2,000.00. A grouped list for the phone follows in its own change. The header names the person signed in now. A second save against a newer version keeps the typed values until Reload, which loads the server schedule and its version. The conflict line stays on screen, its text is darker than the amber token, Reload and the Risk select are 44px, and a save with no version that would change the fee is 409 with no write and no refusal row. The screen and the server price a cheque fee with the same integer-cent half-up helper. Payroll at 2% of 1,000.25 is 20.01. A float multiply prints 20.00. A face of 1,000.5 is the same 20.01. Fee %, a minimum, and a maximum accept at most 2 decimal places on save. More than that is a 400 that names the field, and the schedule is unchanged. A fee % says "That change didn't save. A fee % can have up to 2 decimals, like 2.25." The check reads the number, so 1e-7 is refused and 1e2 is 100. The Fee % field is text. Clearing it and leaving the field restores the saved percent. The table and the edit state show a stored 2.125 as 2.13, the figure booking uses, so saving another row stores 2.13 for that percent. A percent already stored with more places rounds half up to 2 when the fee is read, and the cheque still books. The cheque route books a face of 1000.5 at 2% as 20.01. A figure the helper cannot read is refused on save and at booking, by the same reader, so a schedule that saves can still be priced. An unreadable figure is not booked as 0.00. Min fee "4." tidies to 4.00, and Fee % "." restores the saved percent. The teller sees "Nothing was cashed. The fee for this cheque type can't be read. The owner or a manager can fix it in Cheques, Fee schedule." The places banner is 13px, outlines the field that broke the rule, and sets aria-invalid. The phone table's sideways scroll stays until the grouped-list change.

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

**2026-10-18**, cheque schedule on every desk. Migration 045 writes the default schedule where none is stored. A stored null, an empty string, `[]`, or a value that is not a non-empty JSON array is missing, and the default is written. A schedule already stored, including 0%, is left byte for byte. One audit row per desk that changes, actor `system migration`, with the value before and the value after. A second run writes none. A desk created afterwards, including signup, onboarding, an admin, the platform tenant, and the York FX seed, is given that default at creation.

**2026-10-18**, cheque fee rounding. The screen and the server share one integer-cent helper. Payroll at 2% of 1,000.25 books 20.01, and a face of 1,000.5 is the same 20.01. Fee %, a minimum, and a maximum accept at most 2 decimal places on save. More than that is a 400 that names the field, and the schedule is unchanged. A fee % says "That change didn't save. A fee % can have up to 2 decimals, like 2.25." The check reads the number, so 1e-7 is refused and 1e2 is 100. The Fee % field is text. Clearing it and leaving the field restores the saved percent. The table and the edit state show a stored 2.125 as 2.13, the figure booking uses, so saving another row stores 2.13 for that percent. A percent already stored with more places rounds half up to 2 when the fee is read, and the cheque still books. The cheque route books a face of 1000.5 at 2% as 20.01. A figure the helper cannot read is refused on save and at booking, by the same reader, so a schedule that saves can still be priced. An unreadable figure is not booked as 0.00. Min fee "4." tidies to 4.00, and Fee % "." restores the saved percent. The teller sees "Nothing was cashed. The fee for this cheque type can't be read. The owner or a manager can fix it in Cheques, Fee schedule." The places banner is 13px, outlines the field that broke the rule, and sets aria-invalid. The phone table's sideways scroll stays until the grouped-list change.

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

**2026-10-17**, owner-only settings. Non-owners may change only the
allowlist their screens write. A manager may also change the default
spread. A teller who sends a different default spread is refused,
audited, and the stored spread is kept. A different owner-only value,
including the large-cash line, is refused whole and audited. Leaving a
derived key out (role presets, billing plan) keeps the stored value
and saves the rest. A refusal of any other save reloads the stored
  desk and saving continues. The settings rail follows the signed-in
  role. Rates & fees locks every price except the default spread, which
  a manager or the owner can change. A teller gets no Save on that
  panel. A manager's line says they can change the default spread. A
  teller's line says to ask the owner or a manager. A locked amount
  shows two decimals. A refused Rates & fees save keeps the typed
  values and repeats that person's line above Save, with no toast and
  no error code. A manager cannot move the large-cash line. The ledger
  threshold route was already the owner's.

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

**2026-10-19**, public site claims. The public pages say what the
desk does today. Canada is the only live country. In Canada the
desk applies the identification lines and will not post a deal
over a line until a teller records the ID. Staff check the
document in person. Outside verification is not connected. A
refused attempt is not written to the book. The desk does not
draft or send a suspicious transaction report. A desk runs under
one country's rules, chosen at setup. Adding a location does not
load a second pack. Singapore and Hong Kong have no pack. The compliance page and
the home Hong Kong card both state money changing at HK$120,000
and remittance and wire transfer at HK$8,000. The home card says
the MSO licence is not tracked and names five-year records under
AMLO Schedule 2, section 20. The home Singapore card says the
payment licence is not tracked. Each Singapore row on the compliance
page says "No Singapore pack is built." Verified
and Verified Plus are planned badges, not connected. The desk
does not read a licence. Records stay while the account is open,
and keeping them for the statutory period is the shop's
obligation. Export is the ledger CSV, a client report, and report
CSVs. There is no single export of every client file with its ID
scans. CurrencyDesk staff can reach a desk for setup, support,
security, or a legal demand. Hosting is Render in Oregon, in the
United States. The database is Neon [Neon region: to confirm].
The pages do not name a Neon region. Privacy section 8 shows
[Data processing terms with Render and Neon: to confirm]. The placeholder is followed by a period. The
desk does not delete records on a schedule while the account is
open, and keeping them for the statutory period is the shop's
obligation. The pages also name Cloudflare, Resend,
Stripe, Twilio, Google, Tavily, and ElevenLabs. A storefront quote
number is used only for that quote and its confirmation, and the
pages say the desk does not send marketing to it. Admin changes are
logged. Admin reads are not described as logged. A quote can be
texted to the number given, only for that quote, when texting is
set up. If texting is not set up, no message is sent. Sanctions
screening is not connected. The AI copilot
is marked coming soon, not included yet, with a neutral chip,
and it is not in the AI
Bundle's list of live features. FAQ 40 does not offer a full
export on request. The AI Bundle stays $749. Founder
offers and the other printed prices are unchanged. Em dashes and
en dashes are out of the visible copy, titles, and meta.

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
not billed. That pass named only Render (hosting, United
States) and Neon (database) as service providers. Hero and feature amounts that are not a
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
