# Server storage for transfers

The transfer desk still keeps its working records in one browser.
Beneficiaries (`cdos_beneficiaries_v1`), corridors and partners
(`cdos_corridors_v1`), the transfer list and its status timeline
(`cdos_transfers_v1`), and settlements (`cdos_settlements_v1`) are
arrays in `localStorage`. The rate lock (`yorkfx_rates_locked`) is a
`'1'` or `'0'` in the same store. `server/src/db/schema.ts` has no
table for any of them. The persist bridge copies those keys into
`tenant_state`, which is one JSON document per tenant, so two tills
still share a document and a cleared browser still loses the record.

A copy in one browser is not retention. Canada keeps the desk's
records for the pack's period, five years on the Canada pack, longer
if the desk has raised `legal_entities.retention_years`
(`docs/CLIENT_RECORDS.md`, `docs/DESK_THRESHOLDS.md`). Nothing in
this work deletes a row. Disposition stays unbuilt.

This document is the build plan. It does not change the product.
Each section below is one pull request, in the order they merge.
Handwritten source in each of those pull requests stays around 400
lines. The compiled `web/app/os.js` is rebuilt in any pull request
that touches `os-src/` and is committed with it, because CI rejects
a stale bundle. That generated file is not a reason to split the job.

## What stays as it is

The New transfer cash step stays the call it already is.
`TransferModal` in `os-src/cdos-transfers.jsx` posts cash first,
through `postRemittanceSend` or `postRemittanceReceive`
(`/api/ledger/remittances/send` and `/receive`), and writes the
browser row only after that call returns. Those routes, the
idempotency key, the obligation, and the drawer update are
unchanged. The record route added below stores the transaction id,
the obligation id, and the reference the cash step already returned.
It does not insert a ledger row and it does not call the remittance
service.

"Record settlement" on the Settlement tab is the browser's note of a
wire to a partner. It is not the ledger's obligation settlement
(`docs/OBLIGATION_LINES.md`). These pull requests store that note.
They do not post it to the book, and they do not change till balances.

Cancel and hold stay a status on the transfer. Open pull requests
#130 and #138 own the cash reversal and the reason captured before a
cancel. This plan does not take that work. If those have merged by
the time the transfer pull request is built, the cancel control they
shipped stays, and the new route only appends the status event
beside it.

The offline demo, with no session and no database, keeps reading
`localStorage`, including the demonstration pipeline the screen
already falls back to. These routes register only when a database
URL is configured, the same gate as the client routes.

## Migrations

`040_till_balance_generation` is the last migration on `main`.
Adding one still means the three places in `docs/MIGRATION.md`: the
SQL file, the list in `server/src/db/migrations.ts`, and the Drizzle
table in `server/src/db/schema.ts` plus the `DDL` constant in
`server/src/db/index.ts`. PGlite applies `DDL` and does not run the
SQL files, so the table has to exist in both. The append-only
trigger lives in the SQL file. The Postgres test is what proves the
trigger. An applied file is never edited.

Do not pick a number in advance. When a pull request in this
sequence is written, list the files in `server/src/db/migrations/`
on `main` and the migration filenames on every open pull request,
and take the lowest integer none of them use. On 2026-10-12 the
open claims were:

| number | pull request | file |
| --- | --- | --- |
| 041 | #96 | `041_persona_inquiry_events.sql` |
| 041 | #132 | `041_till_session_timezone.sql` |
| 041 | #110 | `041_staff_contact.sql` |
| 041 | #120 | `041_till_signoff.sql` |
| 042 | #130 | `042_transfer_paid_out.sql` |
| 043 | #138 | `043_transfer_cancel_hold.sql` |
| 044 | #141 | `044_signin_rate_limit.sql` |

041 is claimed four times. 042, 043, and 044 are claimed once each.
027 is still open on #57. Another pull request can take the next
integer before this work is built, so this document does not reserve
one. The five pull requests take five numbers, in the order below,
each number chosen on the day that pull request is written. They
are not required to be consecutive.

## Scope, identity, and the import

Every table has `tenant_id`, and every query uses the session's
tenant. The request body cannot name a tenant, a legal entity, or a
branch. That is the same rule as `server/src/clients/routes.ts`.

Beneficiaries, transfers, transfer events, and settlements also
store `legal_entity_id` from the session. The browser has one list
per origin, and `tenant_state` is one document per tenant, so a
tenant with two legal entities is not split by guess. Imported rows
take the entity on the session, which is the limitation
`019_client_records.sql` already states. Corridors and the rate lock
are one row-set per tenant, because the browser has one corridor
list and one lock flag.

The server mints every new id (`ben_`, `cor_`, `prt_`, `xfr_`,
`evt_`, `stl_`, then a UUID). The browser stops minting `b` +
`Date.now()` and `t` + `Date.now()` once that screen reads the
server. The old browser id is kept as `legacy_id`, unique per
tenant, and the JSON the screen renders puts that legacy id in `id`
when one exists. `bookTransfers` and `bookBeneficiaries` in
`os-src/cdos-transfers.jsx` exclude `t1`–`t4` and `b1`–`b3` by that
field. Keeping it there means a sample row stays off the client file
and out of a filing, which is the rule those two functions already
enforce. A row created after the cutover has no legacy id, so the
screen's `id` is the server id, and the sample filter does not match
it.

Money is `numeric(24,2)`. Rates are `numeric(24,12)`, which holds the
four-decimal transfer rate and the six-decimal settlement rate. The
import stores the decimal text the browser had. A null spread stays
null. A missing home cost stays null. A zero is not written in its
place (`docs/ABSENT_FIGURES.md`).

The browser's stamps are strings from `toLocaleString('en-CA')`,
such as `2026-06-18 10:12`. Each imported row keeps that string, and
the screen keeps showing it, so a timeline line reads as it does
today. `occurred_at` / `created_at` is a timestamptz parsed in the
branch's zone when the string parses, and the original text when it
does not. New rows format with the same `stamp()` the screen uses now.

### One import, no loss

Each pull request adds one import route for its own key. The browser
calls it after hydrate has finished, and posts the value it holds.
The server also reads that same key out of `tenant_state.state` for
the session's tenant, because the persist bridge may have a row this
tab does not.

Rows are united by legacy id.

- A row on only one side is inserted.
- A row already stored under that legacy id is left as it is. A
  second import does not overwrite it, so a stale tab cannot revert
  an edit or drop an event. Edits after the cutover go through the
  write route.
- A transfer timeline is the union of the events. An event matches
  on status, the original timestamp text, the actor name, and the
  note. Events that appear on only one side are kept. Order follows
  the browser's array, and events that exist only in the blob are
  appended after it.
- The whole import for that key is one database transaction.

The response lists every legacy id now stored, including ids that
came only from the blob. The screen starts reading the server when
every id it sent is in that list. Until that response arrives, the
screen keeps reading and writing `localStorage`, and it does not
delete the key. A failed request, a short list, or a network error
leaves the browser copy untouched.

After a successful import the server is the record. The local key is
rewritten from the server payload so an old tab still sees the rows.
Deleting the key would look, to a tab that has not reloaded, like
somebody else removed it, which is the failure
`docs/CLIENT_RECORDS.md` describes for the client blob. The catalogue
line for the key in `server/src/state/shape.ts` is updated in the
same pull request, from "browser record" to "cache of the table."

Demonstration ids `t1`–`t4` and `b1`–`b3` are stored when the screen
actually has them, with `demonstration` true. They are not invented
when the key is absent. Compliance and the client file keep using
`bookTransfers` and `bookBeneficiaries`. The pipeline returns them,
because the pipeline shows them today.

An absent corridors key is the eight corridors `defaultCorridors()`
already paints, Eurozone inactive. The import sends that list, and
those rows are marked `seeded`. A saved list is imported as saved,
including a corridor the desk has turned off.

An absent rate lock, or any value other than `'1'`, imports as
unlocked. `'1'` imports locked, and brings `yorkfx_locked_at` and
`cdos_locked_book` when those keys are present. The live board
(`yorkfx_rates_v1`, `rate_boards`) is not part of this import.

## Permissions

Routes check a permission, the way the rest of the server does.
Holders below are the roles in `server/src/auth/permissions.ts`.

`rates:change` is the permission that publishes a board, and it stops
at branch manager and administrator. The lock control is on the shell
for everyone who works the desk (`os-src/cdos-os.jsx`, the lock
button, and the staff board in `YorkFX/yorkfx-staff.js`). A new
permission `rates:lock` covers that control. Its holders are teller,
supervisor, compliance officer, branch manager, and administrator.
Auditor does not receive it.

| action | permission | who has it |
| --- | --- | --- |
| Read the rate lock | a signed-in session | all six roles |
| Set the rate lock, and import it | `rates:lock` | teller, supervisor, compliance officer, branch manager, administrator |
| Read beneficiaries | `customer:view` | all six roles |
| Save or import a beneficiary | `customer:write` | teller, supervisor, compliance officer, branch manager, administrator |
| Read corridors | `ledger:view` | all six roles |
| Turn a corridor on or off, and import corridors | `customer:write` | teller, supervisor, compliance officer, branch manager, administrator |
| Read transfers, events, settlements | `ledger:view` | all six roles |
| Create a transfer record, and import transfers | `transaction:post` | teller, supervisor, branch manager, administrator |
| Append a status event | `transaction:post` or `compliance:file` | those four, plus the compliance officer |
| Record a settlement, and import settlements | `transaction:post` | teller, supervisor, branch manager, administrator |

The corridor toggle uses `customer:write` because that is the set of
people who can already change a customer file, which is everyone at
the desk except the auditor, and the Corridors tab does not hide the
toggle today. Creating a transfer record uses `transaction:post`,
the same permission `remittanceSend` already requires, so the person
who just posted the cash can store the row. A compliance officer can
append a hold, a release, or a cancel through `compliance:file`, and
cannot create a transfer or record a wire.

The controls stay where they are. A role the server refuses gets the
denial the ledger already returns. The layout does not change to
match.

## How the desktop and the phone switch

Both screens are the same components. The desktop opens Transfers as
a window. The phone opens it from More. Wider than 430px, the window,
the tabs, the New transfer modal, the detail drawer, the lock button,
and the LOCKED badge stay as they are. This work changes where the
rows are read and written. It does not change copy, layout, or
controls, and it does not add a phone-only screen.

A signed-in desk with a database reads and writes the routes below.
The screen maps the JSON back onto the object shape the components
already take (`name`, `sender`, `corridor`, `payAmt`, `timeline`, and
the rest), so the cards render the same fields. With no session, the
screen keeps the local store it has today.

The rate lock is the same row for every screen of the tenant. The
shell already polls the staff board every three seconds and already
listens for `yorkfx_rates` storage events. A click sends the PUT and,
when that call returns, writes `yorkfx_rates_locked`,
`yorkfx_locked_at`, and `cdos_locked_book` with the values the server
stored. The staff iframe keeps reading those keys and is not
rewritten. If the PUT fails, the keys are left as they were, so the
badge does not flip ahead of the server. A poll that finds a
different flag writes the keys the iframe already watches, which is
how a phone and a second till show LOCKED together.

A transfer saved on the phone is the row the desktop window lists,
and the reverse, because both call the same route.

## The tables that only gain rows

Canadian record retention is why three tables accept an insert and
refuse an update or a delete. The Canada pack keeps records for five
years, and a desk may only lengthen that. An examiner's question
about a transfer is how it moved, not only the word it ended on. The
same reason is already written on `ledger_obligation_events`: the
status column would say where something is, and the event row says
how it got there. These three tables use the existing
`ledger_append_only()` trigger, `BEFORE UPDATE OR DELETE`.

| table | what a new row is |
| --- | --- |
| `desk_transfers` | the transfer as it was taken. Amounts, the beneficiary snapshot, the pin, and the ledger ids are written once |
| `desk_transfer_events` | one status change: created, sent, transit, paid, hold, or cancelled |
| `desk_partner_settlements` | one wire to a partner. The screen already only prepends these |

Current status is the latest event, ordered by `occurred_at` then
id. There is no status column on `desk_transfers` to overwrite.
Release from hold appends a new `sent` event, which is what the
Release button does today (`advance('sent', 'Released after review')`).
The timeline can hold two `sent` events. The screen keeps painting
each step of Created → Sent → In transit → Paid out from the first
event of that status, which is what `timeline.find` does now, and the
pill reads the latest event.

`desk_beneficiaries` is the current directory and can be edited. The
transfer copies the name, address, relationship, bank, account,
pickup city, and wallet id onto its own row at insert, so a later
edit of the beneficiary does not rewrite a transfer already taken.
Canada pack version 2 already requires the name and address on the
ledger once the cash is at the remittance line. Those fields on the
cash call stay as they are. The copy on the transfer row is the same
facts, kept with the timeline.

`desk_corridors` updates `active` in place. That is the on/off
switch, not a transaction record. Partner rows are inserted with
their corridor. This plan has no route that edits a partner, because
the screen has no such control. `desk_rate_locks` is one current row
per tenant and is updated in place. It is not a retained transaction.

## Pull request 1 — rate lock

The smallest one, and the first. One row per tenant.

`desk_rate_locks`

| column | type |
| --- | --- |
| `tenant_id` | text, primary key, references `tenants` |
| `locked` | boolean, not null |
| `locked_at` | timestamptz, null |
| `locked_book` | jsonb, null. The `cdos_locked_book` snapshot the shell already writes on the same click. Without it, a second screen would freeze whatever its board is at the moment it notices the flag |
| `updated_by` | text, null. The session's staff id |
| `updated_at` | timestamptz, not null |

Routes:

- `GET /api/desk/rate-lock`
- `PUT /api/desk/rate-lock` with `{ locked: boolean }`. The server sets
  `locked_at` when the flag turns on, clears it when the flag turns
  off, and stores the book body when the client sends the snapshot it
  just took. Turning the lock off clears the snapshot.
- `POST /api/desk/rate-lock/import` with the flag, the timestamp, and
  the book, under the import rules above.

Tests, in this pull request: a teller can read and set the flag; an
auditor can read and cannot set it; a second tenant's row is
invisible; import of `'1'` stores locked and import of a missing key
stores unlocked; a second import does not flip a lock the desk has
since changed; `npm run check:parse` after the shell change. A seam
drives the lock control and then reads the row. The staff iframe is
left on its current keys.

`yorkfx-staff.js` is not edited. The shell writes the keys it already
reads.

## Pull request 2 — beneficiaries

`desk_beneficiaries`

| column | type |
| --- | --- |
| `id` | text, primary key |
| `tenant_id` | text, not null |
| `legal_entity_id` | text, not null |
| `legacy_id` | text, null. Unique with `tenant_id` |
| `demonstration` | boolean, not null, default false |
| `name` | text, not null |
| `relationship` | text, null |
| `sender_name` | text, null. The browser field `sender`, which is a name, not a client id |
| `corridor_code` | text, null. `PH`, `IN`, and the rest. Text, not a foreign key, because this pull request lands before corridors |
| `method` | text, null. `bank`, `cash`, or `wallet` |
| `partner_name` | text, null |
| `pickup_city` | text, null |
| `phone` | text, null |
| `address` | text, null |
| `bank_name` | text, null |
| `branch_name` | text, null. The beneficiary's bank branch, not the desk's branch |
| `account` | text, null |
| `wallet_id` | text, null |
| `created_text` | text, null |
| `created_at` | timestamptz, not null |
| `updated_at` | timestamptz, not null |

There is no delete route. The screen has no delete.

Routes:

- `GET /api/desk/beneficiaries`
- `POST /api/desk/beneficiaries`
- `PATCH /api/desk/beneficiaries/:id` — the fields the edit modal
  already saves, and at least one of them
- `POST /api/desk/beneficiaries/import`

The Clients window and the New transfer modal both read this list.
They keep the props they have. `docs/CLIENT_RECORDS.md` currently says
beneficiaries are browser-only. That sentence is updated in this pull
request, and `docs/PROJECT_STATE.md` is updated because the record has
moved.

Tests: a teller saves a beneficiary and a second tenant cannot read
it; an auditor can read and cannot save; import of three rows returns
three ids and a second import inserts nothing; a row whose legacy id
is `b1`, `b2`, or `b3` is stored with `demonstration` true; a failed
import rolls back the whole batch. The seam saves a beneficiary from
the screen, reloads, and reads the name back from the table.

## Pull request 3 — corridors and partners

`desk_corridors`

| column | type |
| --- | --- |
| `id` | text, primary key |
| `tenant_id` | text, not null |
| `code` | text, not null. Unique with `tenant_id`. The browser's id: `PH`, `IN`, `CN`, `MX`, `AE`, `GB`, `EU`, `US` |
| `country` | text, not null |
| `payout_currency` | char(3), not null |
| `flag` | text, null |
| `active` | boolean, not null |
| `seeded` | boolean, not null, default false |
| `updated_at` | timestamptz, not null |

`desk_corridor_partners`

| column | type |
| --- | --- |
| `id` | text, primary key |
| `tenant_id` | text, not null |
| `corridor_id` | text, not null, references `desk_corridors` |
| `name` | text, not null. Unique with `tenant_id` and `corridor_id` |
| `methods` | text[], not null. Any of `bank`, `cash`, `wallet` |
| `eta_hours` | numeric, null |

The only write the screen has is the corridor switch. Partner rows
ride along on the import and are not edited later.

Routes:

- `GET /api/desk/corridors` — each corridor with its partners nested,
  in the shape `corridors.map` already walks
- `PATCH /api/desk/corridors/:code` with `{ active: boolean }`
- `POST /api/desk/corridors/import`

Tests: the eight default corridors import, Eurozone inactive, and a
saved list that has turned one off imports that way; the toggle
flips `active` and does not insert a second corridor; a partner name
is unique inside its corridor; a second tenant sees none of the
first tenant's rows; an auditor can read and cannot toggle. The seam
turns a corridor off and reloads, and New transfer no longer offers
it, which is what the switch does today.

## Pull request 4 — transfers and the status history

Depends on pull request 2, so a beneficiary legacy id can be linked.
The corridor is stored as a code, not a foreign key, so a transfer
whose code is missing from `desk_corridors` still imports.

`desk_transfers` — insert only, trigger included.

| column | type |
| --- | --- |
| `id` | text, primary key |
| `tenant_id` | text, not null |
| `legal_entity_id` | text, not null |
| `branch_id` | text, null. The session's branch, recorded so the row says where it was taken. The list is not filtered by it, because the browser list is one list and filtering it would drop rows off the desktop |
| `legacy_id` | text, null. Unique with `tenant_id` |
| `demonstration` | boolean, not null, default false |
| `reference` | text, not null. On a new transfer, the reference the cash step returned. On import, the reference the browser stored |
| `pin` | text, null. The server mints the pin on create. Import keeps the stored pin |
| `direction` | text, not null. `send` or `receive` |
| `sender_name` | text, not null |
| `beneficiary_id` | text, null, references `desk_beneficiaries` when the legacy id matches a row |
| `beneficiary_legacy_id` | text, null |
| `beneficiary_name` | text, null |
| `beneficiary_address` | text, null |
| `beneficiary_relationship` | text, null |
| `beneficiary_bank` | text, null |
| `beneficiary_account` | text, null |
| `beneficiary_pickup_city` | text, null |
| `beneficiary_wallet_id` | text, null |
| `corridor_code` | text, null |
| `payout_currency` | char(3), null |
| `method` | text, null |
| `partner_name` | text, null |
| `pay_amount` | numeric(24,2), null |
| `recv_amount` | numeric(24,2), null |
| `rate` | numeric(24,12), null |
| `mid_rate` | numeric(24,12), null |
| `spread_amount` | numeric(24,2), null |
| `fee` | numeric(24,2), null |
| `purpose` | text, null |
| `source_of_funds` | text, null |
| `business_date` | date, null |
| `created_by` | text, null |
| `browser_tx_id` | text, null. The local ledger-row id the screen already stores as `txId` |
| `ledger_transaction_id` | text, null |
| `ledger_transaction_ref` | text, null |
| `ledger_obligation_id` | text, null. Unique per tenant where it is not null. This is the retry key |
| `created_text` | text, null |
| `created_at` | timestamptz, not null |

`desk_transfer_events` — insert only, trigger included.

| column | type |
| --- | --- |
| `id` | text, primary key |
| `tenant_id` | text, not null |
| `transfer_id` | text, not null, references `desk_transfers` |
| `status` | text, not null. One of `created`, `sent`, `transit`, `paid`, `hold`, `cancelled` |
| `note` | text, null |
| `actor_name` | text, null. The browser's `by` |
| `actor_staff_id` | text, null |
| `occurred_text` | text, null |
| `occurred_at` | timestamptz, not null |

Index `(transfer_id, occurred_at, id)`.

Routes:

- `GET /api/desk/transfers` — each row with `status` set from the
  latest event and `timeline` in order
- `POST /api/desk/transfers` — inserts the row and the `created`
  event in one transaction. The body carries the ledger ids the cash
  step returned. It does not move cash
- `POST /api/desk/transfers/:id/events` with `{ status, note }`
- `POST /api/desk/transfers/import`

Create on the screen stays: cash post first, unchanged; then this
POST. If this POST fails, the screen keeps that one transfer in
`localStorage` and retries this POST with the same obligation id. It
does not call the cash route again. The unique obligation id makes
the retry the same row.

Tests: appending `sent` leaves the `created` event in place, and an
`UPDATE` or `DELETE` on `desk_transfer_events` and on `desk_transfers`
raises the append-only error (Postgres, `TEST_DATABASE_URL`); hold
then release stores `created`, `hold`, `sent` in that order and the
latest is `sent`; import keeps every timeline event and does not drop
a row that exists only in `tenant_state`; a second tenant cannot read
the first; creating a transfer record does not change
`ledger_till_balances` or insert an obligation; a retry with the same
obligation id returns the one row. The seam creates a transfer on a
desk whose cash post is the existing remittance route, then reads the
event row. `cd server && npm run typecheck && npm test`, plus that
Postgres run. A fresh database.

The cross-border report keeps the sentence that it is not the ledger.
These rows are the transfer record. They are not a second book of
cash.

## Pull request 5 — settlements

Depends on pull request 4 only because the Settlement tab adds the
two lists together. The settlement table does not reference
`desk_transfers`. The browser never stored that link. It sums by
corridor and partner name, and the screen keeps doing that sum. The
owed figure and the float figure are not columns.

`desk_partner_settlements` — insert only, trigger included.

| column | type |
| --- | --- |
| `id` | text, primary key |
| `tenant_id` | text, not null |
| `legal_entity_id` | text, not null |
| `branch_id` | text, null. Recorded, not a filter |
| `legacy_id` | text, null. Unique with `tenant_id` |
| `reference` | text, not null. The `STL-` reference the screen stored. New ones are minted by this route, from the branch business date, the way the screen already builds `STL-` plus the day |
| `partner_name` | text, not null |
| `corridor_code` | text, not null |
| `currency` | char(3), not null |
| `amount` | numeric(24,2), not null |
| `fx_rate` | numeric(24,12), null |
| `home_cost` | numeric(24,2), null. The browser field `cadCost`. The name is the desk's home currency, which is not always CAD. Null when the browser had no figure |
| `business_date` | date, null |
| `actor_name` | text, null |
| `note` | text, null |
| `created_text` | text, null |
| `created_at` | timestamptz, not null |

Routes:

- `GET /api/desk/settlements`
- `POST /api/desk/settlements`
- `POST /api/desk/settlements/import`

No patch and no delete. A wrong wire is a later row, and this plan
does not add a reversal button.

Tests: an update or a delete raises the append-only error; import of
two wires returns both and a second import inserts nothing; a missing
`cadCost` is stored null; posting a settlement does not change an
obligation's status and does not change a till balance; the screen's
owed figure still comes from committed payouts minus these rows. The
seam records a settlement and reads the row back. Same suites as
pull request 4, on a fresh database.

## Order

Build and merge in this order. One job each. Handwritten source
around 400 lines. The next free migration number, chosen that day.

1. **Rate lock.** `desk_rate_locks`, `rates:lock`, the shell mirrors
   the flag into the keys the board already reads.
2. **Beneficiaries.** `desk_beneficiaries`, linked from Clients and
   from New transfer.
3. **Corridors and partners.** `desk_corridors` and
   `desk_corridor_partners`, and the on/off switch.
4. **Transfers and status history.** `desk_transfers` and
   `desk_transfer_events`. The cash step stays in front of the record
   write.
5. **Settlements.** `desk_partner_settlements`. The position stays a
   sum of payouts and these rows.
