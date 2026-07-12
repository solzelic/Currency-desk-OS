# Prototype-to-React Parity Matrix

Reference viewport: `1440 x 900`. Prototype capture: `test-results/prototype-desktop.png` (regenerated locally from `CurrencyDesk OS.html`). The preserved prototype is authoritative for layout and interaction vocabulary. React may only route regulated writes through its scoped domain, authorization, persistence, and audit boundaries.

Status: **exact** = currently matches the approved behavior and visual intent; **partial** = represented but not equivalent; **missing** = not available in React; **intentionally deferred** = documented prototype capability that requires a separate secured domain migration.

| Prototype location / surface | React equivalent | Status | Visual and behavioral delta | Data / writes / dependencies | Acceptance criterion |
| --- | --- | --- | --- | --- | --- |
| `cdos-os.jsx: Lock` staff sign-in | `SignInScreen` | partial | Prototype is staff ID/password then OTP/branch picker; React uses seeded staff chooser. | Staff, active session; React writes scoped sign-in audit. | Preserve locked paper screen and route sign-in through audited session boundary. |
| `cdos-os.jsx: Otp` | None | intentionally deferred | No MFA or real identity flow in demo. | Identity provider, session assurance. | Do not emulate production MFA with local-only state. |
| `cdos-os.jsx: StationPicker` | Workspace context | partial | Prototype selects branch/till before desktop; React uses seeded workspace. | Branch/till scope. | Add only with backend/scoped persistence design. |
| `cdos-os.jsx: #menubar` / account, bell, calculator, rate lock, settings, power | `WorkspaceShell.os-menubar` | partial | React keeps brand, active app, session context, sign-out; misses notification menu, calculator, lock, settings/account menus. | Alerts, rate lock, staff settings, audit. | Match light 44px chrome and add only actions with secured implementations. |
| `cdos-os.jsx: #tenantbar` / ticker / station switcher | `WorkspaceShell.os-tenantbar` | partial | React has branch/till and compact static ticker; prototype has live scrolling rate book and till switcher. | Workspace, rate book, branch/till. | Match dimensions/tokens; live rates remain deferred. |
| `cdos-os.jsx: #appbar` / dock | `WorkspaceShell.os-appbar` | partial | React exposes migrated slice apps; prototype includes Rate Board, Ledger, Transfers, Cheques, Clients, Compliance, Reports, Pricing, Dashboard, Assistant and utilities. | App registry, subscription, permissions. | Match row geometry/state indicators; un-migrated apps remain explicitly deferred. |
| `cdos-os.jsx: Win` / drag, resize, focus, close, minimize, zoom, duplicate, tile | `WorkspaceShell` window manager | partial | React supports open/focus/minimize/restore/close/drag; no resize, zoom, duplicate, or tiling menu yet. | Presentation state only. | No domain mutation from chrome; add resize/tile only when covered by browser tests. |
| `cdos-os.jsx: Ledger` / Records tab, Compliance tab, KPI strip, search, filters, table, New transaction | `LedgerSummary`, Exchange Desk | partial | React ledger is a compact transaction table; prototype has richer filters/detail/new-transaction modal. | Ledger, customers, compliance, receipts; React writes only via authorized posting service. | Match table density and add filters after maintaining scoped authorization. |
| `cdos-txmodal.jsx` / Currency Exchange form | `ExchangeDraftForm` | partial | React supports draft, quote, compliance, post; it lacks prototype transaction-type tabs, swap control, modal layout and metadata. | Draft, customer, quote, compliance; post via `src/domain/posting.ts`. | Match form hierarchy without allowing direct posting bypass. |
| `cdos-clients.jsx` / list, filters, quick card, profile, KYC fields | `CustomerPanel` / Clients window | partial | React selects and creates basic customers; no search/filter/profile/evidence. | Customers; create emits audit event. | Do not persist KYC files in localStorage. |
| `cdos-compliance*.jsx` / alerts, filing, LCTR | `ComplianceChecklist` | partial | React has deterministic pass/warn/block pre-post checks only. | Draft/customer/till; no filing write. | Preserve blocking result at post boundary. |
| `cdos-till.jsx` / count, handoff, close day | `TillSummary` | partial | React shows positions/reset; no counting/handoff/day close. | Till, receipt, ledger; reset audited. | Till changes remain outputs of authorized posting. |
| `cdos-vault.jsx` / cash on hand | None | intentionally deferred | Prototype-only inventory dashboard. | Vault shifts, till holdings. | Requires inventory/write model. |
| `cdos-branches.jsx` / branch network | Workspace context only | intentionally deferred | No branch network or moves. | Branches, tills, movements. | Requires tenant and branch administration model. |
| `cdos-transfers*.jsx` | None | intentionally deferred | No React transfer workflow. | Customers, beneficiaries, corridors, compliance. | Separate transaction domain and permissions required. |
| `cdos-cheques*.jsx` | None | intentionally deferred | No React cheque workflow. | Cheques, customers, schedule. | Separate domain and compliance controls required. |
| `cdos-dashboard.jsx` | None | intentionally deferred | No dashboard cards/charts. | Read-only aggregates. | Reuse secured read model. |
| `cdos-reports.jsx` | None | intentionally deferred | No reports/exports. | Ledger, customers, till, audit. | Export must enforce `records:export`. |
| `cdos-pricing.jsx` / Rate Board | Static ticker only | intentionally deferred | No editable rates. | Rate book. | Must enforce `rates:change`. |
| `cdos-apps.jsx` / Store, Assistant, Calculator, Loan, Tagged, Audit | None | intentionally deferred | No corresponding React apps. | App layout, audit, calculation inputs. | Migrate independently; audit viewer is read-only. |
| `cdos-settings.jsx` / employees, settings, billing | None | intentionally deferred | No settings UI. | Tenant configuration, staff. | Backend configuration boundary required. |
| `cdos-search.jsx`, `cdos-import.jsx`, `cdos-kyc.jsx`, `cdos-lctr.jsx` | None | intentionally deferred | Prototype support modules only. | Search index, import, KYC, filing. | Do not migrate as visual-only shells. |
| Receipt modal / print | `ReceiptPanel` | partial | React receipt is a window panel and lacks print/modal formatting. | Receipt produced by posting. | Preserve immutable receipt reference and transaction link. |
| Toasts, notification bell, audit logs | Post status line / audit persistence | partial | React has post status and immutable audit events but no visual audit timeline/bell. | Audit events. | UI must remain read-only over append-only history. |

## Cross-cutting parity constraints

- Prototype module event handlers are a behavior reference, not code to copy. React uses typed state and pure domain functions.
- Customer creation, posting, till update, ledger update, receipt creation, sign-in/sign-out, and reset retain current tenant scope, authorization, persistence, and audit behavior.
- Browser localStorage remains demo-only and must not hold real KYC documents or production financial data.
- Visual work is accepted only after fixed-view screenshots show the light menu/tenant/app bars, desk texture, window proportions, dense table/form language, and the working vertical slice together.
