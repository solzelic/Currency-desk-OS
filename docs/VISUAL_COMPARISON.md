# Visual Comparison References

This is a deliberately traceable comparison index, not a claim of pixel-for-pixel parity. The React baselines test the desktop shell, working Exchange Desk, and posted-transaction desktop state against the visual rules in `VISUAL_SOURCE_OF_TRUTH.md`.

| State | Approved prototype reference | React Playwright baseline | Comparison focus |
| --- | --- | --- | --- |
| Desktop shell | [prototype-desktop.png](../test-results/prototype-desktop.png) | [desktop-shell.png](../tests/e2e/visual-shell.spec.ts-snapshots/desktop-shell-chromium-darwin.png) | Light menu bar, tenant strip, dock, paper desktop, window chrome, watermark. |
| Exchange initial | [01-flow4.png](../screenshots/01-flow4.png) | [exchange-desk-initial.png](../tests/e2e/visual-shell.spec.ts-snapshots/exchange-desk-initial-chromium-darwin.png) | Transaction form geometry and initial compliance state. |
| Customer selected | [01-flow4.png](../screenshots/01-flow4.png) | [exchange-desk-customer-selected.png](../tests/e2e/visual-shell.spec.ts-snapshots/exchange-desk-customer-selected-chromium-darwin.png) | Customer selection, exchange inputs, quote hierarchy, compliance state, transaction command. |
| Completed exchange | [01-ledger.png](../screenshots/01-ledger.png) | [completed-transaction.png](../tests/e2e/visual-shell.spec.ts-snapshots/completed-transaction-chromium-darwin.png) | Receipt, posted ledger entry, till update, and multi-window workspace state. |
| Multi-window | [01-cdos-multi.png](../screenshots/01-cdos-multi.png) | [multi-window.png](../tests/e2e/visual-shell.spec.ts-snapshots/multi-window-chromium-darwin.png) | Window stacking, dock state, and shared workspace data. |
| Minimized/restored | [01-cdos-dock.png](../screenshots/01-cdos-dock.png) | [minimized-window.png](../tests/e2e/visual-shell.spec.ts-snapshots/minimized-window-chromium-darwin.png) | Dock indicators and restore behavior. |

## Review method

1. Open the prototype and React reference image side by side at their recorded viewport.
2. Check the desktop layers first: menu bar, tenant context, dock, paper field, and window stack.
3. Check operational controls next: title bars, traffic-light controls, tables, forms, quote, status colors, and amount typography.
4. Reject changes that introduce a generic dashboard, card grid, sidebar-first navigation, or unrelated visual language.

The React implementation intentionally validates its own working vertical slice rather than reproducing every prototype app before that app has been migrated. All six current React references were reviewed after regeneration at `1440 x 900`; the remaining differences are tracked in `PROTOTYPE_PARITY_MATRIX.md` rather than hidden by a new visual language.
