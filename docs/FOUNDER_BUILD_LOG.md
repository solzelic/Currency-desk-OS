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
- Maintain a source-to-baseline comparison index in `docs/VISUAL_COMPARISON.md`.
- Verify that shell windows can open, focus, minimize, close, and reopen in Chromium coverage.

## Deliberate non-goals

- No changes to the legacy prototype.
- No new financial product module or business workflow.
- No claim of SOC 2, GDPR, AML, FINTRAC, or other regulatory compliance.
- No attempt to make demo localStorage crash-atomic or suitable for real data.

## 2026-07-11: Visual shell validation

- Root Vite build now emits both `index.html` and the compatibility `frontend.html` entry, so the designed shell is available at `/` in development and production preview.
- Added production-served copies of the approved prototype application icons for the React shell; the original `uploads/` source assets remain unchanged.
- Added Chromium visual baselines for the desktop shell, Exchange Desk, and completed transaction state.
- Validation passed: typecheck, 30 unit tests, production build, and 6 Chromium end-to-end tests.

## 2026-07-11: Prototype parity pass

- Captured the preserved executable prototype at `1440 x 900` through its sign-in, OTP, branch-picker, and desktop sequence.
- Added `PROTOTYPE_PARITY_MATRIX.md`, covering every visible prototype application and the shell, panel, window, menu, transaction, customer, compliance, receipt, till, audit, and deferred-module boundaries.
- Aligned React chrome to the prototype's light 44px menu bar, 52px tenant/rate strip, 58px application row, centered 1040px work-window geometry, compact spacing, and translucent rounded chrome.
- Expanded deterministic Chromium references to desktop default, Exchange Desk initial, customer-selected, completed transaction, multi-window, and minimized/restored states.
