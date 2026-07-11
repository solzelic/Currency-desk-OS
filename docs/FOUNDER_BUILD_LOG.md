# Founder Build Log

## 2026-07-11: Product blueprint and visual shell started

- Branched from main after the security and compliance foundation merge.
- Preserved the legacy prototype as an immutable visual and interaction reference.
- Audited the prototype application registry, window manager, dock, navigation links, legacy module boundaries, React vertical slice, authorization boundary, persistence adapters, and test suite.
- Defined the screen, navigation, data, permission, and visual-source maps in this documentation set.
- Chosen implementation boundary: keep calculations, posting authorization, scope checks, persistence, and audit behavior in existing React/domain modules; replace only the visible application shell and component styling.

## Planned in this branch

- Add a reusable desktop window manager with open, focus, minimize, and close behavior.
- Host the validated Exchange Desk workflow inside the OS shell.
- Add Ledger, Till, Receipt, Customer, and Compliance views as linked windows over shared React state.
- Add Playwright visual regression baselines for the shell, Exchange Desk, and completed transaction.

## Deliberate non-goals

- No changes to the legacy prototype.
- No new financial product module or business workflow.
- No claim of SOC 2, GDPR, AML, FINTRAC, or other regulatory compliance.
- No attempt to make demo localStorage crash-atomic or suitable for real data.
