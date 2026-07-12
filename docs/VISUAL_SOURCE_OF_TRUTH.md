# Visual Source of Truth

## Canonical reference

The preserved prototype is the approved source of truth:

- `CurrencyDesk OS.html`
- `CurrencyDesk OS (standalone).html`
- `os-src/`
- prototype references in `screenshots/`

The React application must take visual direction from those files, not from generic dashboard conventions. The legacy files are preserved and are not to be modified as part of the React migration.

## Required visual language

| Element | Reference behavior to preserve |
| --- | --- |
| Desktop | Warm off-white/beige paper surface with restrained speckle texture and a subtle lower-right `CD·OS` watermark. |
| Typography | Archivo for operational UI; Space Mono for labels, rates, identifiers, and utility metadata. |
| Menu bar | Dense black utility bar, CurrencyDesk wordmark, active app name, rate/status items, staff control, power action. |
| Tenant strip | White, compact business and station context with live rate ticker. |
| Dock | Horizontal app row with line icons, mono labels, active underline, application accent color, and open/minimized state. |
| Windows | White/translucent sheets, narrow title bars, hairline borders, soft shadow, Mac-like red/amber/green controls, modest square corners. |
| Content | Paper-like tables, hairline dividers, folder-style tabs where appropriate, compact forms, tabular amounts, dark primary command buttons. |
| Colors | Ink black, paper white, warm grey hairlines, controlled green for healthy/approved states, amber for warning, red for blocking. |

## Exactness constraints

- Do not replace the OS with cards, a sidebar, a marketing hero, or a generic SaaS dashboard.
- Do not introduce decorative gradients, floating orbs, oversized rounded cards, or a purple/slate product palette.
- Preserve dense operational spacing, line weight, window chrome, and mono metadata hierarchy.
- Keep button, table, tab, and form treatment rectangular to softly rounded; windows may be lightly rounded but are not floating cards.
- The responsive mode may stack or maximize windows, but it must retain the menu bar, dock, desktop texture, and window vocabulary.

## Screenshot references

- [Prototype desktop state](../screenshots/01-cdos-windows.png)
- [Prototype transaction capture](../screenshots/01-flow4.png)
- [Prototype locked entry](../screenshots/01-01-desktop.png)
- React visual regression baselines are documented in `docs/VISUAL_COMPARISON.md` after they are generated.
