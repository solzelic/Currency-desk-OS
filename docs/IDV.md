# Identity check providers

Persona remains the default provider. Didit is a second provider behind the
same `IdvProvider` adapter. A shop with no row, or a row that still says
`persona`, is unchanged. Checks stay off until the owner turns them on.

Didit is sandbox only. A shop can select it only when `tenants.is_test_shop`
is true. On Render (`RENDER` exactly `true`) Didit is not selectable unless
this process is staging or `DIDIT_LIVE_ALLOWED` is exactly `1`. That variable
stays unset. A loopback `DIDIT_API_BASE` is ignored on live Render.

## Env names

Set these on the server. Do not commit values. The workflow id below is
Didit's sandbox workflow and is not a secret.

| Env | Use |
| --- | --- |
| `DIDIT_API_KEY` | `x-api-key` for `POST /v3/session/` and `GET /v3/session/{id}/decision/` |
| `DIDIT_WEBHOOK_SECRET` | HMAC secret for `POST /api/webhooks/idv/didit` |
| `DIDIT_WORKFLOW_ID` | Tier 3, ID and selfie. Sandbox example: `89c8dc5a-2673-4603-973a-b7172aa33c33` |
| `DIDIT_AML_WORKFLOW_ID` | Ignored in this slice. Tier 4 stays off even when this is set |
| `DIDIT_LIVE_ALLOWED` | Stays unset until the reseller agreement and the DPA are signed |

If the key, the webhook secret, or the tier 3 workflow id is missing, a Didit
start and the Didit webhook answer `503` `{ "error": "not_available" }`.

`DIDIT_API_BASE` is optional and is not set on Render. The public value must
be `https://verification.didit.me` with no userinfo and with port 443 or no
port. A loopback URL is accepted only off Render or on staging, so a local
stub can stand in. Off Render means `RENDER` is not exactly `true`. Any other
value is ignored.

## What a check does

In person and returning client do not call a provider. Tier 3 on a Didit shop
opens Didit's Basic KYC workflow (ID, liveness, face match). Tier 4 is
off. Setting `DIDIT_AML_WORKFLOW_ID` does not turn it on. A failed, abandoned, or
declined scan is not billed. This slice does not settle a credit for a pass
either.

The webhook accepts `status.updated` and `data.updated`. The signature is
HMAC-SHA256 over the raw body (`X-Signature`), or the canonical JSON form
(`X-Signature-V2`). The timestamp must be within 300 seconds. A repeat of the
same session id and status is one event. The decision body is not stored and
is not logged. The desk does not copy the ID photos or the selfie.

## Didit before live

`DIDIT_LIVE_ALLOWED` stays unset until the reseller agreement (Didit terms 6.3)
and the DPA are signed. These five items are still open:

1. Store the s.105 photo ID fields and reject expired documents, the same way Persona does.
2. The live gate (`DIDIT_LIVE_ALLOWED` stays unset).
3. Retention, deletion, and data location in the consent copy.
4. Declining the face match sends the client to the counter with no session.
5. Approved consent copy.

## Staging

1. Confirm the shop is a test shop (`is_test_shop`).
2. As the owner, set the identity provider to Didit and turn checks on.
   On the desk this is Settings, Clients, Identity provider, and only when
   the shop is allowed to choose Didit.
3. Point Didit's sandbox webhook at
   `https://currencydesk-staging.onrender.com/api/webhooks/idv/didit`
   for `status.updated` and `data.updated`, version v3.
4. Start an ID and selfie check. The counter shows a `verify.didit.me` link.

`GET /api/idv/clients/:clientId` also returns `provider` and `ready`
(`off`, `not_test_shop`, `not_configured`, `privacy_missing`, `ok`) to any
signed-in desk role. The consent read returns the same `ready`. A stopped
check on the desk says why. Customer consent uses "the staff at this counter"
when the privacy contact is empty, and drops the privacy-policy sentence when
there is no URL. Staging still blocks the customer link until the privacy
fields are set. That fallback wording is draft for Compliance review (CD-219).

The same screen lists five steps: share a link or a QR code, the customer
scans their ID, the customer takes a selfie, the result comes back, and
there is no charge if the check fails. A Persona shop does not show them.

## References

- https://docs.didit.me/sessions-api/create-session
- https://docs.didit.me/sessions-api/retrieve-session
- https://docs.didit.me/integration/webhooks
- https://docs.didit.me/integration/verification-statuses
