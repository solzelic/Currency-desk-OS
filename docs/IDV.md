# Identity check providers

Persona remains the default provider. Didit is a second provider behind the
same `IdvProvider` adapter. A shop with no row, or a row that still says
`persona`, is unchanged. Checks stay off until the owner turns them on.

Didit is sandbox only. A shop can select it only when `tenants.is_test_shop`
is true. On a live host (`www.currencydeskos.com` or `currencydeskos.com`,
and `STAGING` is not `1`) Didit is not selectable unless `DIDIT_LIVE_ALLOWED`
is exactly `1`. That variable stays unset.

## Env names

Set these on the server. Do not commit values. The workflow id below is
Didit's sandbox workflow and is not a secret.

| Env | Use |
| --- | --- |
| `DIDIT_API_KEY` | `x-api-key` for `POST /v3/session/` and `GET /v3/session/{id}/decision/` |
| `DIDIT_WEBHOOK_SECRET` | HMAC secret for `POST /api/webhooks/idv/didit` |
| `DIDIT_WORKFLOW_ID` | Tier 3, ID and selfie. Sandbox example: `89c8dc5a-2673-4603-973a-b7172aa33c33` |
| `DIDIT_AML_WORKFLOW_ID` | Optional. Tier 4, ID, selfie and database. Unset means that tier answers `not available yet` |
| `DIDIT_LIVE_ALLOWED` | Unset. `1` is the only value that lets a live host select Didit |

If the key, the webhook secret, or the tier 3 workflow id is missing, a Didit
start and the Didit webhook answer `503` `{ "error": "not_available" }`.

`DIDIT_API_BASE` is optional and is not set on Render. It is accepted only
for `https://verification.didit.me` or a loopback URL off a live host, so a
local stub can stand in. Any other value is ignored.

## What a check does

In person and returning client do not call a provider. Tier 3 on a Didit shop
opens Didit's Basic KYC workflow (ID, liveness, face match). Tier 4 stays
disabled until `DIDIT_AML_WORKFLOW_ID` is set. A failed, abandoned, or
declined scan is not billed. This slice does not settle a credit for a pass
either.

The webhook accepts `status.updated` and `data.updated`. The signature is
HMAC-SHA256 over the raw body (`X-Signature`), or the canonical JSON form
(`X-Signature-V2`). The timestamp must be within 300 seconds. A repeat of the
same session id and status is one event. The decision body is not stored and
is not logged. The desk does not copy the ID photos or the selfie.

## Staging

1. Confirm the shop is a test shop (`is_test_shop`).
2. As the owner, set the identity provider to Didit and turn checks on.
   On the desk this is Settings, Clients, Identity provider, and only when
   the shop is allowed to choose Didit.
3. Point Didit's sandbox webhook at
   `https://currencydesk-staging.onrender.com/api/webhooks/idv/didit`
   for `status.updated` and `data.updated`, version v3.
4. Start an ID and selfie check. The counter shows a `verify.didit.me` link.

## References

- https://docs.didit.me/sessions-api/create-session
- https://docs.didit.me/sessions-api/retrieve-session
- https://docs.didit.me/integration/webhooks
- https://docs.didit.me/integration/verification-statuses
