# Stripe Billing launch guide

CurrencyDesk bills the licensed MSB for its software. It does not use Stripe
Connect and it must not send the MSB's own money-exchange or remittance flows
through Stripe. Card collection, tax calculation, invoices and subscription
management are Stripe-hosted.

## 1. Configure the Stripe test account

1. In Stripe **test mode**, create one Product and recurring Price for every
   plan/cycle pair:

   | CurrencyDesk plan | Required environment variables |
   | --- | --- |
   | Basic | `STRIPE_PRICE_BASIC_MONTHLY`, `STRIPE_PRICE_BASIC_ANNUAL` |
   | Pro | `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL` |
   | Premium | `STRIPE_PRICE_PREMIUM_MONTHLY`, `STRIPE_PRICE_PREMIUM_ANNUAL` |

   Use immutable Price IDs (`price_…`), never client-supplied amounts. Make the
   annual prices reflect the final commercial discount before a customer uses
   them.

2. Add the appropriate SaaS product tax code and activate **Stripe Tax**. Add
   CurrencyDesk's business address and tax registrations before collecting
   tax. Automatic tax is enabled for every Checkout Session in the backend.

3. In **Customer Portal**, enable payment-method updates, invoice history,
   cancellation, and the plan/cycle changes that CurrencyDesk wants to permit.
   Limit portal switches to the same approved Price IDs above.

4. For per-file KYC billing, create a Stripe Billing Meter whose event name is
   `currencydesk_kyc_verification` (or choose another stable name and set
   `STRIPE_KYC_METER_EVENT_NAME`). Attach its metered Price to qualifying
   subscriptions. Call `reportKycUsage` only after a verification has reached
   its final billable state; its stable verification ID makes a replay safe.

5. Create a test webhook destination at
   `https://<test-host>/api/billing/webhook`, select these events, and copy
   that endpoint's signing secret (not an API key):

   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.finalized`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `invoice.voided`

## 2. Configure the application

Set these only in the local secret file or hosting-provider environment
settings. Do not commit them, place them in browser code, or paste them into
chat.

```sh
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_BASE_URL=https://your-test-domain.example
STRIPE_PRICE_BASIC_MONTHLY=price_...
STRIPE_PRICE_BASIC_ANNUAL=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_PRICE_PREMIUM_MONTHLY=price_...
STRIPE_PRICE_PREMIUM_ANNUAL=price_...
STRIPE_KYC_METER_EVENT_NAME=currencydesk_kyc_verification
```

`APP_BASE_URL` is required in production; it prevents Checkout redirects from
being built from an untrusted request host. A publishable key is not needed
for the current hosted Checkout/Portal integration.

## 3. Verify test mode before launch

1. Start a subscription from each plan and cycle. Confirm Checkout collects a
   billing address and tax ID where appropriate, shows automatic tax, and
   returns to `/app`.
2. Confirm the matching webhook is delivered with a valid signature. A paid
   invoice updates the tenant entitlement; a browser cannot directly PATCH a
   paid plan.
3. Send a duplicate event from Workbench. It must return success without a
   second entitlement or invoice projection.
4. Test a declined recurring payment and confirm the customer is directed to
   the Customer Portal. Configure Stripe's recovery/dunning settings before
   live launch.
5. Verify invoice and PDF links in the portal, cancellation-at-period-end,
   a plan switch, tax calculation for each jurisdiction, and one metered KYC
   event against a test subscription.

## 4. Live-mode checklist

Complete Stripe account activation, bank payouts, MFA, customer-facing
business details/statement descriptor, tax registrations, portal
configuration, and a separate **live** webhook endpoint/secret. Then replace
only `sk_test_`, `whsec_`, and `price_` values with their live counterparts in
the production environment. Deploy, confirm `/api/health`, and run one small
real end-to-end subscription only after the Stripe dashboard and webhook
delivery logs are clean.

The backend stores Stripe IDs, billing status and invoice URLs locally. It
does not store card numbers, CVCs, billing addresses, or raw webhook payloads.
