# Ledger Posting API

The ledger service is the authoritative backend boundary. It accepts transaction inputs, not browser-calculated totals. PostgreSQL `numeric` and `decimal.js` derive the quote, CAD valuation, spread, journal, till movements, receipt response, and audit evidence in one serializable transaction.

The direct exchange endpoint is retained only for legacy/demo compatibility and
does not apply a commercial multiplier. Production commercial pricing is
created by the Quote Service and posted through frozen quote terms.

## Endpoints

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/health` | none | Readiness: 200 if a trivial database read succeeds, 503 `{ ok: false, error: "database" }` if it does not. |
| `GET` | `/api/ledger/readiness` | session cookie + `ledger:view` | Reports whether the active workspace has customers and till balances. |
| `GET` | `/api/ledger/customers` | session cookie + `customer:view` | Lists relational customers in the active workspace. |
| `POST` | `/api/ledger/customers` | session cookie + `customer:write` | Creates or syncs a customer; `externalRef` makes synchronization idempotent. ID status is not a field of the body. |
| `PUT` | `/api/ledger/customers/:customerId` | session cookie + `customer:write` | Updates name and risk in the active workspace. ID status is not a field of the body. |
| `GET` | `/api/ledger/till-balances` | session cookie + `ledger:view` | Returns authoritative balances for the active till. |
| `POST` | `/api/ledger/opening-balances` | manager/supervisor + `till:initialize` | Sets opening balances exactly once, before ledger activity. |
| `GET` | `/api/ledger/transactions?limit=100` | session cookie + `ledger:view` | Returns newest authoritative transactions and reversal state. |
| `POST` | `/api/ledger/exchanges` | session cookie | Legacy/demo posting only; production returns `410 QUOTE_REQUIRED`. |
| `POST` | `/api/ledger/transactions/:transactionId/reversal` | session cookie + `transaction:reverse` | Creates an explicit reversal with a required reason. |

The authenticated actor is resolved from the server session. Tenant, legal entity, branch, workspace, user, till, and authorized branches are not accepted from request JSON.

On every ledger or quote request, the authenticated staff role and authorized
branches are mirrored into the exact ledger workspace. The authentication
record remains authoritative: a stale ledger principal cannot retain access
after a role or branch assignment changes. Principals use a composite workspace
key so one staff member can be authorized at more than one till without
overwriting another active scope.

`x-workspace-id` names the till for this request. When it is omitted, the
server uses the workspace recorded on the session — stamped at sign-in to
the first till at the user's home branch, and updated by
`POST /api/ledger/till-selection`. A supplied workspace that is missing or
out of scope returns `403 SCOPE_DENIED`; it never falls back to a different
workspace. Adding a second till at the branch does not deny callers that
omit the header.

## Money and Fees

Amounts are canonical decimal strings with up to two fractional places, a
maximum value of `1,000,000,000.00`, and no exponent notation. `inputAmount`
must be positive and `feeCad` must be non-negative. The API rejects identical
currencies and bounded text fields beyond their documented limits.

Field limits are: idempotency key 200 characters, customer ID 120 characters,
purpose 500 characters, source of funds 500 characters, and reversal reason
1-1,000 characters.

The explicit current product rule is that `feeCad` is separate CAD tender. It
is **not** included in the currency being exchanged. The till receives the
source currency at `inputAmount` and separately receives CAD at `feeCad`; the
receipt has a separate CAD fee line. The journal debits the functional-CAD
value of source cash plus the CAD fee, then credits destination-cash value, FX
spread revenue, and fee revenue. This rule requires product and policy signoff
before any production rollout; the API name makes the CAD denomination
intentional rather than inferred.

## Failure codes

`AUTHENTICATION_REQUIRED` is returned only when no valid session exists.
`SCOPE_DENIED` is returned when a valid session is outside tenant, legal
entity, branch, workspace, or till scope. `AUTHORIZATION_DENIED` is returned
when the authenticated staff role lacks the named permission.
`INVALID_REQUEST`, `ID_STATUS_NOT_CLIENT_SET`, `CUSTOMER_NOT_FOUND`, `COMPLIANCE_BLOCKED`,
`INSUFFICIENT_TILL_LIQUIDITY`, `RATE_NOT_AVAILABLE`,
`IDEMPOTENCY_IN_PROGRESS`, `TRANSACTION_NOT_FOUND`, `REVERSAL_NOT_ALLOWED`,
`REVERSAL_ALREADY_EXISTS`, `CUSTOMER_EXTERNAL_REF_CONFLICT`,
`OPENING_BALANCES_ALREADY_SET`, and `TILL_ALREADY_ACTIVE` are stable response
codes. Unexpected failures are logged server-side and return only
`500 INTERNAL_ERROR`.

## Local commands

See [server/README.md](../server/README.md) for isolated PostgreSQL startup, migration, seed, API start, and real integration-test commands.

## Limitations

No live KYC provider is connected. `POST` and `PUT /api/ledger/customers`
do not accept an ID standing. A body that carries `idStatus`, `id_status`,
`kycStatus`, `kyc_status`, a `verified` flag, or the same claim nested
under `identity`, `kyc`, or `id` is **422** `ID_STATUS_NOT_CLIENT_SET`.
Teller and owner are the same caller. A new customer is stored as
`missing`. An update does not rewrite `ledger_customers.id_status`.

The value the API returns, and the value a deal is judged against, is
derived from the identity documents on the linked client. One rule,
computed only on the server: ID on file means one current
government-issued photo ID. The type is in
`server/src/ledger/id-document-types.mjs` with `photo` and
`accepted` set, the number is still non-empty after every
whitespace and invisible character is stripped (NBSP, zero-width
space, and the rest of that set), and the expiry is on or after
the desk's business date in the branch's time zone. A blank or
missing `expires_on` counts only when that type's own
`noExpiryAllowed` flag is set. The only such type is `Canadian
citizenship card (pre-2012)`. A date before the business date does
not count, on that type or any other. `Citizenship Card` and
`Citizenship certificate (2012 or later, no photo)` are not photo
ID. A Secure Certificate of Indian Status is a photo ID and needs
an expiry. The laminated Certificate of Indian Status is not in
the catalogue. `Driver's License` is the US spelling of a driver's
licence and needs an expiry. A health card is never
accepted. A non-photo document, including a birth certificate, is
not ID on file. An expired photo ID beside a current non-photo
document is Missing ID, reason "A current photo ID is needed".
The primary flag only chooses which document is shown. A current
photo ID that is not primary is still ID on file. Dual process and
a credit-file method are not supported: the document has no
category and no source, so those methods cannot be recorded.

`POST /api/ledger/customers` accepts `clientId`. The client must
belong to this tenant and legal entity. If this workspace already
has a ledger customer for that client, that row is the one returned
(name and risk updated, standing still derived). Otherwise the
upsert stores `client_id` when the row does not already point at a
different client. The till sends this. An `os:<slug>` row with no
client id cannot see the documents, and a large deal is refused.

The client record and the ledger customer both return `idStanding`
and `displayedDocument` (the primary document, or the earliest
document when none is primary). `idStanding` is `{ status, label,
detail, reason, tone }`, the same shape `displayIdStanding` returns
for a document. `status` is `identified`, `expired`, or `missing`.
`label` is `Identified`, `Expired`, or `Missing ID`. `detail` and
`reason` are the same sentence, and that sentence is copied from
`displayIdStanding`. The two copies have to stay the same. In this
order once every document has been read: a current photo ID is
"An identity document with a number is on file, and it has not
expired."; otherwise an expired photo ID, when no current non-photo
document is filed, is "An identity document on this file is past
its expiry. The till will not treat this customer as identified.";
otherwise a blank or missing expiry on a photo ID that is not the
allow-listed type is "ID has no expiry date"; otherwise a number
that does not survive the strip is "No ID number"; otherwise a type
that is empty or "Not stated" is "ID type not stated"; otherwise a
health card or any other non-photo paper is "A current photo ID is
needed"; otherwise "No ID on file". `tone` is `ok` only for
Identified, and `warning`
otherwise. The helper's provider path, label `Verified`, is not
returned here.
`idStatus` on the ledger customer remains the gate's word
(`verified`, `expired`, `missing`); Identified is `verified`.

A deal that needs identification and does not have it is
`COMPLIANCE_BLOCKED` with the message "ID needed for this amount.
Record the customer's ID." Other compliance refusals keep their own
sentences. An approved provider document would be a row in the same
table; none is connected. A customer already stored as `verified`
with no qualifying document is left in the table and is not ID on
file. A read-only list of those rows is
`scripts/audit-ledger-id-without-document.mjs`. The business date
there is the branch zone's calendar date, not UTC `current_date`.

Opening balances are initialization, not an adjustment mechanism;
after activity begins, differences must use a future counted-reconciliation
workflow. (This table documents the core posting surface; the full ledger
API has grown well beyond it — routes register in
`server/src/ledger/routes.ts`, and the browser posts through them.)
