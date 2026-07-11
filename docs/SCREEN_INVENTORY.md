# Screen Inventory

The following inventory records visible prototype applications. `React status` describes the current branch, not a claim that a production module exists.

| Prototype application | Major screen or view | Opens from | Reads | Writes or affects | React status |
| --- | --- | --- | --- | --- | --- |
| Rate Board | Live rate board | Dock | Rate configuration, lock state | Rates and rate lock | Planned |
| Ledger | Transaction list, filters, transaction detail, new transaction | Dock, dashboard, clients, compliance | Transactions, customers, rates, flags | Transactions, receipt handoff, compliance navigation | Implemented summary; full app planned |
| Transfers | Transfer capture and corridor workflow | Dock, compliance | Customers, beneficiaries, corridors | Transfers, beneficiaries, compliance state | Planned |
| Cheques | Cheque cashing and schedule | Dock, ledger | Customers, cheques, schedule | Cheque records, schedule | Planned |
| Clients and KYC | Customer list, profile, KYC evidence, verified contacts | Dock, ledger, compliance, dashboard | Customers, transactions, KYC | Customer/KYC/beneficiary records | Customer selection and creation implemented; full app planned |
| Compliance | Alerts, review, filing workflow | Dock, ledger, bell | Transactions, customers, filing settings | Review acknowledgements, filings | Live pre-post checklist implemented; full app planned |
| Dashboard | Desk performance and alerts | Dock | Transactions, customers, compliance signals | Opens contextual apps | Planned |
| Till Drawer | Till count, handoff, close day | Dock, branch network | Transactions, till, receipts | Till baseline/counts, day close | Till position summary implemented; full app planned |
| Cash on Hand / Vault | Holdings, shifts, stock bands | Dock | Transactions, till, receipts, floors | Vault shifts and settings | Planned |
| Branch Network | Branch/till selection and transfers | Dock | Branches, tills, movements | Branch/till records, inter-branch moves | Planned |
| Audit Trail | Operational audit log | Dock, session menu | Audit events | No mutation of historical events | Security audit model implemented; visual viewer planned |
| Calculator | FX deal and plain calculator | Dock | Rates | No system records | Planned |
| Loan Centre | Payment calculator | Dock | User inputs | No system records | Planned |
| Reports | Desk, cash, customer, compliance reports | Dock, till | Transactions, customers, cash, reports settings | Report outputs | Planned |
| Pricing and Rates | Rate and pricing administration | Dock | Rates, staff permissions | Rate configuration | Planned |
| AI Assistant | Desk-aware assistant | Dock | Desk snapshot | Conversation state | Prototype-only demo; planned |
| Tagged | Tagged transaction list | Dock | Transactions, customers | Opens transaction details | Planned |
| Settings | Business, staff, permissions, billing | Dock, session menu | Tenant settings, staff, permissions | Configuration and staff settings | Planned |
| Store | Installed, hidden, locked applications | Edge control | Available application metadata, plan | Dock layout and app availability | Planned |

## React vertical-slice screens

| Screen | Read | Write | Primary effects |
| --- | --- | --- | --- |
| Sign in | Staff accounts | Active demo session, audit event | Opens desktop workspace. |
| Exchange Desk | Customers, draft, till, active user | Draft in memory, customer creation | Shows quote and compliance. |
| Customer panel | Scoped customers | New scoped customer, audit event | Selects customer for draft. |
| Compliance checklist | Customer, draft, till | None | Blocks or warns before post. |
| Receipt window | Latest receipt | None | Shows receipt created by posting. |
| Ledger window | Posted transactions, customers | None | Verifies transaction entry. |
| Till window | Till position | Demo reset, audit event | Verifies cash movement. |
