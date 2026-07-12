# Visual Comparison References

This is a deliberately traceable comparison index, not a claim of pixel-for-pixel parity. The React baselines test the desktop shell, working Exchange Desk, and posted-transaction desktop state against the visual rules in `VISUAL_SOURCE_OF_TRUTH.md`.

| State | Approved prototype reference | React Playwright baseline | Comparison focus |
| --- | --- | --- | --- |
| Desktop shell | [01-cdos-windows.png](../screenshots/01-cdos-windows.png) | [desktop-shell.png](../tests/e2e/visual-shell.spec.ts-snapshots/desktop-shell-chromium-darwin.png) | Black menu bar, tenant strip, dock, paper desktop, window chrome, watermark. |
| Exchange capture | [01-flow4.png](../screenshots/01-flow4.png) | [exchange-desk.png](../tests/e2e/visual-shell.spec.ts-snapshots/exchange-desk-chromium-darwin.png) | Customer selection, exchange inputs, quote hierarchy, compliance state, transaction command. |
| Completed exchange | [01-ledger.png](../screenshots/01-ledger.png) | [completed-transaction.png](../tests/e2e/visual-shell.spec.ts-snapshots/completed-transaction-chromium-darwin.png) | Receipt, posted ledger entry, till update, and multi-window workspace state. |

## Review method

1. Open the prototype and React reference image side by side at their recorded viewport.
2. Check the desktop layers first: menu bar, tenant context, dock, paper field, and window stack.
3. Check operational controls next: title bars, traffic-light controls, tables, forms, quote, status colors, and amount typography.
4. Reject changes that introduce a generic dashboard, card grid, sidebar-first navigation, or unrelated visual language.

The React implementation intentionally validates its own working vertical slice rather than reproducing every prototype app before that app has been migrated.
