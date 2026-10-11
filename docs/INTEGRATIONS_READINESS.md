# Integration readiness — Persona, Twilio, Stripe

Written 2026-10-11, against `main`. The owner approved building these
three on that date: they must work the moment real keys are placed in
the Render environment, and they must stay honest and inert until then.
Nothing here adds a key, and nothing here changes product behaviour.
The ordered jobs are at the end of each vendor. Each job is one branch
and one PR, aimed at under about 400 lines of source.

No vendor is at "paste the key and it works" today.

| Vendor | What a key would do today | What the desk shows with no key |
| --- | --- | --- |
| Persona | Nothing. There is no server client and no webhook. | The browser invents a finished ID check on a timer and files it as a Persona result. |
| Twilio | `sendSms` posts to Twilio's Messages API. | The text is logged, the status is `simulated`, and the storefront says "texting goes live soon." |
| Stripe | Hosted Checkout, the Customer Portal, and a signed webhook already run when the secrets and price ids are set. | Admin says Stripe is not configured, then prints **zero** for every money figure. Settings says billing is "being configured." |

`render.yaml` declares the Stripe price ids and `APP_BASE_URL`. It does
not declare `PERSONA_*` or `TWILIO_*`. Those names stay out of the
blueprint until the job that introduces them, and that job sets
`sync: false` with no value. Keys are never committed.

## Persona (KYC)

### What already exists

There is no Persona code under `server/`. The whole check is the
browser module `os-src/cdos-kyc.jsx` (compiled into `web/app/os.js`).

| Piece | Where | What it actually does |
| --- | --- | --- |
| Check store | `os-src/cdos-kyc.jsx` (`cdos_kyc_v1` in `localStorage`) | A click calls `createCheck`. A `setInterval` every 1.2s marks the row completed when `dueMs` passes (about 5s for a "quick" check, about 9s for an ID check). |
| Invented identity | `extractIdentity` in the same file | Address, date of birth, document number, and email are hashed from the person's name. No document was read. |
| Invented decision | `resolve` in the same file | Approved, unless the in-browser sanctions screen (`window.CDOS._compliance.screen`) says hit or review. |
| Certificate | `certHTML` | A printable page that reads as a retained KYC record. The old eleven-person demo seed was removed on purpose (the headstone in that file, and `docs/GENERATED_DOCUMENTS.md`). The timer still manufactures a record of the same kind. |
| Settings | `os-src/cdos-settings.jsx` | A provider dropdown (Persona, Onfido, Sumsub, Trulioo, Veriff) stored in the desk document and in `localStorage`. It changes a label. It does not call a provider. |
| Compliance | `os-src/cdos-compliance-app.jsx` | "New KYC check" opens the same module. The banner says results attach to the contact and the History log. That log is `localStorage` (`cdos_report_history_v1`). |
| Texts screen | `os-src/cdos-telegraph.jsx` | Sample threads include "ID verified via secure link · Persona". They are fixtures in the source, not a delivery. |
| Client file | `server/src/clients/records.ts`, `desk_clients.verification_status` | `verified` means a provider authenticated the document. `refreshVerification` will not grant it and will not clear it. Nothing in the server sets it from Persona, because Persona is not called. |
| Billing hook | `reportKycUsage` in `server/src/routes/billing.ts` | Can report a meter event to Stripe. Nothing calls it. |
| Design reference | `design/kyc-handoff/` | Brand and state artwork. Not a runtime. |

`tests/e2e/document-seam.spec.ts` asserts that a day at the desk leaves
`cdos_kyc_v1` empty. That guards the deleted demo seed. It does not
guard a teller clicking Verify.

### What is fake or simulated

Every completed check the desk can produce today. The reference numbers
(`PSA-…`), the prices ($3.99 / $6.99 / $14.99), the partner discount
codes (`YFX-FOUNDER` and the two beside it), and the "billed" line are
browser arithmetic. No invoice is created. No inquiry id exists.

### Environment variables

None are read. The ones the client will require, both set or neither
counts:

| Variable | What it is |
| --- | --- |
| `PERSONA_API_KEY` | Bearer key. Persona issues `persona_sandbox_…` and `persona_production_…`. The prefix is the sandbox/live switch. The key is not logged. |
| `PERSONA_WEBHOOK_SECRET` | HMAC secret of the webhook endpoint, not the API key. |

Later, not for the first job:

| Variable | What it is |
| --- | --- |
| `PERSONA_INQUIRY_TEMPLATE_ID` | The inquiry template the desk is allowed to start. A browser-supplied template id is refused. |
| `PERSONA_API_BASE` | Optional. Default `https://api.withpersona.com`. Tests inject `fetch` and never set this to a live host. |

### What is missing before a key is enough

- **Webhook with signature verification.** Persona signs
  `Persona-Signature: t=<unix>,v1=<hex>` as HMAC-SHA256 over
  `` `${t}.${rawBody}` ``. Reject a missing signature, a mismatch
  (timing-safe compare), and a timestamp outside five minutes.
  Unknown event names are acknowledged and not stored. The raw body
  is never logged: it contains the name, the date of birth, and the
  document number.
- **Idempotency.** Persona's event id is the primary key. A replay
  returns success and does not write a second row or a second audit
  entry. A processing failure rolls the row back and returns 500 so
  Persona retries.
- **Retries.** The outbound client gets a timeout
  (`AbortSignal.timeout`). A 429 or 5xx may be retried once. A 4xx is
  not retried. The response body is not logged and is not attached to
  the error.
- **Failure the teller can see.** "ID checks not connected yet" while
  either secret is absent. A refused start, a declined inquiry, an
  expired link, and a provider error each get their own sentence.
  The timer must not complete a check in any of those states.
- **Sandbox versus live.** Read from the key prefix and stored on the
  event. The panel says which. A sandbox key and a production webhook
  are different endpoints in the Persona dashboard; one secret verifies
  one environment.
- **Audit.** One `audit_events` row per new event:
  `kyc.persona.recorded`, with the inquiry id, the event id, the
  status, and the client id. No name, no document number, no address,
  no raw payload. The row is linked to `desk_clients.client_id` only
  when Persona's `reference-id` is that id. Any other reference is
  dropped, not stored.
- **The client file.** `verification_status = verified` is set only
  from `inquiry.approved`, in a later job, and `refreshVerification`
  keeps its rule that nothing else clears `verified`. Declined, needs
  review, failed, and expired do not become verified.

### Owner steps in the Persona dashboard

1. Open the Persona organisation. Finish the business verification
   Persona requires before production inquiries.
2. In **Sandbox**, create one inquiry template for the government-ID
   check the desk will sell as "Verified". Note the template id
   (`itmpl_…`). Add a selfie only if that template is the one the
   desk will call Verified Plus. Do not turn on a watchlist the desk
   already claims to run itself until that list is a written decision.
3. Create an API key in Sandbox. It should begin `persona_sandbox_`.
4. Add a webhook endpoint:
   `https://www.currencydeskos.com/api/webhooks/persona`
   Subscribe to `inquiry.completed`, `inquiry.approved`,
   `inquiry.declined`, `inquiry.marked-for-review`, `inquiry.failed`,
   and `inquiry.expired`. Copy that endpoint's signing secret.
5. Put `PERSONA_API_KEY` and `PERSONA_WEBHOOK_SECRET` in the Render
   dashboard for the `currencydesk` service. Leave them unset until
   the client job below is on `main`. Do not paste them into git,
   chat, or the browser.
6. Send one sandbox inquiry. Confirm the dashboard shows the delivery
   as signed and the desk shows the stored status, not a timer result.
7. Repeat steps 2–6 in **Production** with a `persona_production_…`
   key, a new webhook secret, and the live template id. Sandbox and
   production are different endpoints; the live secret does not verify
   a sandbox delivery.

### Jobs, in order

1. **`feat/persona-client`** — Server client and webhook receiver.
   Signature verification. Enabled only when both secrets are set.
   Without them, `GET /api/kyc/persona` answers
   `{ connected: false, message: "ID checks not connected yet" }` and
   the identity panel and the compliance banner show that sentence
   instead of starting the timer. Results are append-only
   (`persona_inquiry_events`, migration `041`) and, when the
   reference id is a real client id, linked to `desk_clients` and
   `audit_events`. Tests use recorded payloads and an injected
   `fetch`. No network. No PII in logs. Does not set
   `verification_status`. Does not edit `render.yaml`.
2. **`feat/persona-start-inquiry`** — The Verify button calls the
   client with the server-side template id and `reference-id` equal
   to `client_id`. The timer no longer completes a check. A timeout,
   a 4xx, and a missing template each show a sentence on the panel.
   One retry on 429 and 5xx.
3. **`feat/persona-result-on-file`** — The client profile reads the
   stored events. `inquiry.approved` is the only writer that sets
   `verification_status` to `verified`. Declined, needs review,
   failed, and expired stay visible and do not become verified.
4. **`feat/persona-environment`** — Store sandbox or live from the
   key prefix. The panel says which. `render.yaml` gains
   `PERSONA_API_KEY`, `PERSONA_WEBHOOK_SECRET`, and
   `PERSONA_INQUIRY_TEMPLATE_ID` as `sync: false` with no values.

## Twilio (texts)

### What already exists

| Piece | Where | What it actually does |
| --- | --- | --- |
| Transport | `server/src/sms.ts` `sendSms`, `normalizePhone` | Plain `fetch` to `https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json`. Basic auth. No SDK. Prefers `TWILIO_MESSAGING_SERVICE_SID`, else `TWILIO_FROM`. If `TWILIO_WHATSAPP_FROM` is set, the quote goes out as WhatsApp instead of SMS. |
| Storefront quote | `server/src/routes/public-site.ts` | The hold text, including `Reply STOP to opt out`, is sent and stored on `rate_quotes.sms_status` / `sms_text`. Confirm sends a second text and ignores the returned status (`void sendSms`). |
| Storefront copy | `YorkFX/yorkfx-site-config.js` | `sent` says the details were texted. `simulated` says "SMS preview — texting goes live soon." `failed` falls through with no sentence of its own. |
| Onboarding code | `server/src/routes/onboarding-public.ts` | `VERIFY_CHANNEL=phone` texts the 6-digit code. The default is `email`. `docs/ONBOARDING.md` still says there is no SMS provider; the transport above is that provider, and it is simulated until the variables below are set. |
| Tests | `server/tests/public-site.test.ts` | Asserts `smsStatus === "simulated"` and that the stored text contains the ref and the STOP line. No test stands up Twilio. |
| Desk texts | `os-src/cdos-telegraph.jsx` | A local sample inbox. It does not call `sendSms`. |

There is no Twilio route, no status callback, and no signature check.
`render.yaml` has no `TWILIO_*` key.

### What is fake or simulated

With any of account SID, auth token, or a from-address missing,
`sendSms` prints `[sms simulated] to=<phone> :: <full body>` and
returns `"simulated"`. The body of a quote contains the customer's
phone and the amount. The body of an onboarding code **is the code**.
A failed Twilio response logs `res.text()`, which can echo that body.
Callers are told the status and do not throw. That part is honest.
The log line is not.

The texts screen, the "ID verified via secure link" sample, and the
"texting is included in every plan" price note are fixtures.

### Environment variables

Read in `server/src/sms.ts`. A send is live only when SID and token
are set and at least one of the three from-addresses is set.

| Variable | What it is |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Account SID (`AC…`). |
| `TWILIO_AUTH_TOKEN` | Auth token. Also the key that will verify `X-Twilio-Signature`. |
| `TWILIO_FROM` | E.164 sender, used when no messaging service is set. |
| `TWILIO_MESSAGING_SERVICE_SID` | `MG…`. Preferred for A2P 10DLC. Optional. |
| `TWILIO_WHATSAPP_FROM` | Optional. When set, **replaces** SMS for quotes (`whatsapp:+…`). The comment in `sms.ts` names Twilio's sandbox number as the example. |

`VERIFY_CHANNEL=phone` is a separate switch. It does not by itself
make Twilio live.

### What is missing before a key is enough

- **Status webhook with signature verification.** Twilio signs
  `X-Twilio-Signature` (HMAC-SHA1 over the URL and the sorted form
  fields, using the auth token). Without it, a delivered quote can
  sit at `sent` after the carrier rejected it, and a forged callback
  could move the status.
- **Idempotency.** `MessageSid` + status is the key. A replay does
  not write a second audit row.
- **Retries.** One timeout, one retry on 429 and 5xx, no retry on
  4xx. The confirm path must record the status it currently discards.
- **Failure the customer can see.** `failed` on the storefront needs
  its own sentence. `simulated` stays the no-key sentence.
  Onboarding must not say a code was texted when the status is
  `simulated` or `failed`.
- **Sandbox versus live.** Trial accounts, the WhatsApp sandbox, and
  a registered 10DLC campaign are different. The health check should
  say which from-address is in use, and a WhatsApp override should
  be visible, because it silently replaces SMS.
- **Audit.** One `audit_events` row per send: action, status, quote
  ref or onboarding ref. Not the body, not the code, not the full
  phone number (last four digits at most).
- **Logs.** The simulated line and the failure line stop including
  the body. Tests that read a code from the log today read email
  (`[email simulated]`), not SMS, except the walkthrough line in
  onboarding which prints a demo code on purpose.

### Owner steps in the Twilio console

1. Open the Twilio account. A trial can only text verified numbers.
   Upgrade before a shop depends on it.
2. For Canadian and US SMS, register the brand and the A2P 10DLC
   campaign, and attach the campaign to a Messaging Service. The
   quote text already includes `Reply STOP to opt out`. Use that
   campaign's sample, not a second wording, or the campaign review
   fails.
3. Buy or port the shop number. Put it on the Messaging Service as
   the sender. Copy the Messaging Service SID.
4. WhatsApp, if used, is a separate sender
   (`TWILIO_WHATSAPP_FROM`). The sandbox is joined by each recipient
   once. Do not point production quotes at the sandbox number.
5. After the status-callback job is on `main`, set the status
   callback on that Messaging Service to
   `https://www.currencydeskos.com/api/webhooks/twilio`.
6. Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either
   `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM` in Render. Leave
   `TWILIO_WHATSAPP_FROM` unset unless WhatsApp is the intended
   channel. Leave `VERIFY_CHANNEL` at `email` until a real text of
   the onboarding code has been received.
7. Send one quote to a handset the account is allowed to text.
   Confirm the storefront says it was texted only after Twilio
   accepts it, and that a STOP from that handset is honoured by
   Twilio (the server does not keep its own stop list; the comment
   in `public-site.ts` says Twilio handles STOP).

### Jobs, in order

1. **`fix/sms-log-redaction`** — `sendSms` logs the status and a
   redacted destination. It does not log the body. A non-2xx logs
   the HTTP status only. Behaviour of `sent` / `simulated` /
   `failed` stays. Tests still pass with no Twilio account.
2. **`feat/twilio-status-webhook`** — `POST /api/webhooks/twilio`
   verifies `X-Twilio-Signature`, stores MessageSid and status
   without the body, and is idempotent. Absent token: 503 and no
   row. Recorded form bodies only. No network.
3. **`feat/sms-failure-on-screen`** — The storefront has a sentence
   for `failed`. The confirm path stores the status it sends. The
   onboarding response names `simulated` and `failed` instead of
   `ok: true` when the text did not leave.
4. **`feat/sms-send-audit`** — Timeout, one retry on 429/5xx, and an
   audit row that carries the ref and the status, not the body.
5. **`chore/twilio-env-slots`** — `render.yaml` lists the Twilio
   variables `sync: false` with no values. The texts screen's sample
   threads are labelled as samples in the same job only if that
   label fits; otherwise it is its own small PR,
   `fix/telegraph-sample-label`.

## Stripe (shop billing)

This is CurrencyDesk charging the shop for the software. It is not
Stripe Connect, and it is not the shop's FX or remittance money.
`docs/STRIPE_BILLING.md` is the launch checklist. This section is the
gap between that checklist and the code.

### What already exists

| Piece | Where | What it actually does |
| --- | --- | --- |
| Config | `server/src/billing/stripe.ts` | Live when `STRIPE_SECRET_KEY` is non-empty. Price ids for basic/pro × monthly/annual, optional premium, optional `STRIPE_KYC_METER_EVENT_NAME`. `stripe` SDK `2026-06-24.dahlia`, `maxNetworkRetries: 2`. |
| Checkout and portal | `server/src/routes/billing.ts` | Administrator session. Checkout is hosted, tax on, card collected even for a $0 first invoice, idempotency key from the browser's UUID. Portal needs an existing Stripe customer. `billing.checkout_started` is audited. |
| Webhook | `POST /api/billing/webhook` | `Stripe-Signature` via `constructEvent`. Event id is inserted first (`stripe_events`). A duplicate returns `{ received: true, duplicate: true }`. Processing failure deletes the claim and returns 500 so Stripe retries. Handled: `checkout.session.completed`, `customer.subscription.*`, `invoice.*`. `invoice.paid` copies the subscription's plan onto `tenants.plan`. |
| Tables | `server/src/db/migrations/007_stripe_billing.sql`, mirrored in `server/src/db/index.ts` and `server/src/db/schema.ts` | Customer, subscription, invoice, event. No card data, no raw payload. `livemode` is stored on the event. |
| Tests | `server/tests/billing.test.ts` | Unsigned request is 400. A signed checkout, subscription, and paid invoice project once. The duplicate invoice does not double the row. Stripe's own test-header helper signs the payload. No network. |
| Desk | `os-src/cdos-settings.jsx` | "Manage billing in Stripe" opens the portal. A missing configuration says "Billing is being configured. Please contact CurrencyDesk support to change plans." |
| Admin | `admin.html` billing page, `GET /api/admin/billing` in `server/src/routes/admin.ts` | Pill "Stripe connected" or "Stripe not configured". If connected and no webhook has arrived, it says the numbers cannot move. Unpaid and uncollectible invoices are listed under needs-attention. |
| Health | `server/src/platform/health.ts` | Stripe is `ok` when the secret is set, `warn` when a desk is on a paid plan and the secret is not, `off` otherwise. |
| Blueprint | `render.yaml` | `APP_BASE_URL` is `https://www.currencydeskos.com`. Six `STRIPE_PRICE_*` values are in the file (price ids are public). `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are `sync: false`. `STRIPE_KYC_METER_EVENT_NAME` is not declared. |

`GET /api/billing` returns `configured: false` and empty projections
when the secret is absent. Checkout and the portal return 503
`billing_not_configured`.

### What is fake or simulated

The integration itself is real. Two presentations are not.

- With no key, the admin page says the figures below are **zero rather
  than wrong** (`admin.html`). `docs/ABSENT_FIGURES.md` says a figure
  the book cannot answer is absent, never zero. MRR, cash collected,
  and tax collected at `$0.00` on an unconfigured deployment are the
  defect that page is trying to avoid, written as a zero.
- `reportKycUsage` is unreachable. A KYC meter event name in the
  environment would not bill anything, because no verification calls
  it. That is the correct inert state until Persona approvals exist.
- The plan change on `invoice.paid` is not audited. Checkout start is.
  The entitlement move is the one that changes what the desk may do.

`safeAppBaseUrl` swallows a bad URL in an empty `catch`. The webhook
signature failure is an empty `catch` that returns 400
`invalid_signature`. The refusal is right. The empty catch is the
kind this repository does not add again.

There is no explicit request timeout beyond the SDK's network retries.
Sandbox versus live is whatever key was pasted. `livemode` is stored
and never shown. A test key and a live webhook secret fail
verification, which is safe, and the panel still says "Stripe
connected" with no mode.

### Environment variables

| Variable | Required to charge | What it is |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes | `sk_test_…` or `sk_live_…`. Restricted key. The prefix is the mode. |
| `STRIPE_WEBHOOK_SECRET` | Yes, or the webhook returns 400 | `whsec_…` for this endpoint. |
| `APP_BASE_URL` | Yes in production | Already set in the blueprint. Checkout will not use the request host in production. |
| `STRIPE_PRICE_BASIC_MONTHLY` | For the Rates plan | `price_…` |
| `STRIPE_PRICE_BASIC_ANNUAL` | For the Rates plan | `price_…` |
| `STRIPE_PRICE_PRO_MONTHLY` | For Full System | `price_…` |
| `STRIPE_PRICE_PRO_ANNUAL` | For Full System | `price_…` |
| `STRIPE_PRICE_PREMIUM_MONTHLY` | For AI Bundle | `price_…` |
| `STRIPE_PRICE_PREMIUM_ANNUAL` | For AI Bundle | `price_…` |
| `STRIPE_KYC_METER_EVENT_NAME` | No | Default in the launch guide: `currencydesk_kyc_verification`. Leave unset until a Persona approval is the thing being billed. |

A missing price id for the plan the desk picked returns 503
`billing_not_configured`, the same as a missing secret.

### What is missing before a key is enough

The signature check, the event-id idempotency, the Stripe retry on
500, and the hosted failure path (portal for a declined card) are
already there. Still open:

- **Audit the entitlement.** `invoice.paid` writes
  `billing.plan_applied` with the tenant id, the plan, and the
  invoice id. No amounts beyond what is already on the invoice row,
  and no customer email.
- **Absent, not zero.** Unconfigured admin tiles render as absent.
  A connected account with no webhook yet keeps the sentence it
  already has.
- **Sandbox versus live, on screen.** The admin pill says Test or
  Live from the key prefix, and warns when the latest event's
  `livemode` disagrees with that prefix.
- **Timeout.** A bounded timeout on the Stripe client, named, with
  the error surfaced as the existing "could not open secure checkout"
  sentence.
- **The empty catches.** The signature failure logs
  `invalid_signature` and nothing else. The bad base URL returns null
  for a reason the log can say without the URL's userinfo.
- **KYC meter.** Stays unwired until `inquiry.approved` is stored.
  Then one call to `reportKycUsage`, whose identifier is already
  `currencydesk:kyc:<verification id>`.

### Owner steps in the Stripe dashboard

`docs/STRIPE_BILLING.md` is the procedure. The short form:

1. In **test mode**, one Product and one recurring Price per plan and
   cycle in the table above. Copy the `price_…` ids. Turn on Stripe
   Tax, the business address, and the tax registrations. In the
   Customer Portal, allow payment-method updates, invoice history,
   cancellation, and only those price ids.
2. Webhook endpoint
   `https://<test-host>/api/billing/webhook` with
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`,
   `invoice.voided`. Copy that endpoint's `whsec_…`.
3. Put the test secret key, the test webhook secret, and the test
   price ids in a non-production environment first. The blueprint's
   price ids are the live catalog. Do not overwrite them with test
   ids on the production service.
4. Run one subscription, one duplicate event from Workbench, and one
   declined renewal. Confirm the duplicate does not change the plan
   twice, and that the declined invoice shows under needs-attention.
5. For live: finish account activation, payouts, MFA, the statement
   descriptor, and a **separate** live webhook endpoint and secret.
   Replace only the secret key, the webhook secret, and the price ids
   on the production service. The code does not contain a second
   switch.
6. Leave the KYC meter off until Persona approvals are stored. The
   event name, when that day comes, is `currencydesk_kyc_verification`.

### Jobs, in order

1. **`fix/billing-absent-when-unconfigured`** — Admin money tiles are
   absent when `connected` is false. The "zero rather than wrong"
   sentence goes away with the zeros. No change to a connected
   account's figures.
2. **`fix/stripe-entitlement-audit`** — `invoice.paid` writes
   `billing.plan_applied`. The signature `catch` logs
   `invalid_signature` and still returns 400. The bad-URL `catch`
   names the failure. Tests cover a second paid invoice that does not
   write a second plan change for the same event id (the existing
   duplicate path).
3. **`feat/stripe-livemode-label`** — The admin pill says Test or
   Live from `sk_test_` / `sk_live_`, and a livemode mismatch with
   the latest event is a warning. No new secret.
4. **`fix/stripe-client-timeout`** — The Stripe client has a bounded
   timeout. Checkout and the portal still return the sentences they
   return today when the provider does not answer.
5. **`feat/stripe-kyc-meter`** — Only after Persona job 3. An
   `inquiry.approved` calls `reportKycUsage` once. No meter name
   means the approval is still stored and nothing is billed.

## What this map does not do

It does not choose a second KYC vendor. The settings dropdown stays a
label until a provider exists; the first jobs speak Persona only.
It does not put shop FX or remittance through Stripe.
It does not turn on `VERIFY_CHANNEL=phone`.
It does not rotate the Resend key (issue #32) or fill any secret.
