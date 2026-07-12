# Data Flow Map

## Vertical slice

```text
Staff actor + workspace scope
  -> selected/new customer
  -> exchange draft
  -> pure quote calculation + pure compliance evaluation
  -> authorized posting boundary
  -> transaction + receipt + ledger + till state
  -> typed persistence adapter
  -> append-only audit event
```

| Record | Scope | Read by | Written by | Related effects |
| --- | --- | --- | --- | --- |
| Workspace | Tenant, legal entity, branch, workspace | Shell, posting, persistence | Demo seed/reset | Determines all scoped records. |
| Staff user | Same scope plus authorized branches | Sign in, shell, posting | Demo seed | Actor in authorization and audit. |
| Customer | Full domain scope | Customer panel, compliance, ledger | Customer creation | Selected for exchange; audited. |
| Exchange draft | In-memory UI state | Exchange Desk, compliance | User input | Never directly persisted. |
| Quote | Derived from draft | Exchange Desk | Pure rate calculation | Output amount, spread, fee, profit. |
| Compliance checks | Derived from customer, draft, till | Checklist, posting | Pure evaluation | Blocking checks reject posting. |
| Transaction | Full domain scope | Ledger, receipt creation, till update | Authorized posting boundary | Produces receipt, ledger entry, till movement. |
| Receipt | Full domain scope | Receipt window | Authorized posting boundary | Identifies posted transaction. |
| Till | Workspace-scoped cash position | Exchange Desk, Till Drawer | Authorized posting boundary | Debits pay-out currency, credits pay-in currency. |
| Audit event | Full domain scope | Future Audit Trail | Store action boundary | Append-only event for sign-in/out, customer creation, posting, failed posting, reset. |

## Prototype application data relationships

| Application | Principal records | Writes or operational impact |
| --- | --- | --- |
| Rate Board / Pricing | Rate book, lock state | Rate configuration and availability. |
| Ledger | Transactions, receipts, customers | Transaction lifecycle navigation. |
| Clients / KYC | Customer, identity/KYC, beneficiaries | Customer and evidence maintenance. |
| Compliance / LCTR | Transactions, customers, alerts, reports | Reviews, acknowledgements, filing work. |
| Till / Vault / Branches | Till counts, vault shifts, branch moves | Physical cash position and movement. |
| Transfers / Cheques | Transfer, cheque, customer, beneficiary | Alternate transaction records. |
| Dashboard / Reports | Aggregates over operational records | Read-only decisions and exports. |
| Audit / Settings | Audit events, staff, permissions, tenant configuration | Administrative changes and evidence. |
