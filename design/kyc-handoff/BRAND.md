# CurrencyDesk OS — Brand & Design Tokens

The full visual language of the product, pulled from the live build (`cdos-base.jsx`
`CD_THEMES`, `york-os.css`). Pair this with `MOTION.md` (timing & animation).

Everything is a CSS custom property (`--cd-*`) written onto `<html>`, so the whole OS
re-skins light↔dark by flipping one attribute (`data-cdtheme`). Components never hardcode
a hex except the one brand accent below.

---

## 1. Brand accent

**CurrencyDesk Blue — `#2B50E2`** (RGB 43·80·226 · CMYK 81·65·0·11 · Pantone 2727 C).
Used for: recommendations, selected states, primary CTAs on the KYC surfaces. It is the
one colour allowed as a literal in components; everything else flows through tokens.

The desk itself is a **black-and-white "rate board" palette** — ink on paper, with three
semantic accents (amber, red, green). Blue is the product/marketing accent layered on top.

## 2. Colour tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--cd-ink` | `#0a0a0a` | `#eceae3` | primary text / near-black surfaces |
| `--cd-ink-strong` | `#000000` | `#ffffff` | max-contrast |
| `--cd-on-ink` | `#ffffff` | `#131210` | text on ink surfaces |
| `--cd-desk` | `#e6e4de` | `#131210` | app backdrop |
| `--cd-paper` | `#f4f3f0` | `#161513` | window/page surface |
| `--cd-paper-soft` | `#faf9f6` | `#1a1917` | raised surface |
| `--cd-panel` | `#ffffff` | `#1e1d1a` | cards / panels |
| `--cd-chip` | `#f1f0ec` | `#262521` | chips / inset fills |
| `--cd-line` | `rgba(10,10,10,.14)` | `rgba(255,255,255,.16)` | borders |
| `--cd-line-soft` | `rgba(10,10,10,.07)` | `rgba(255,255,255,.08)` | hairlines |
| `--cd-mute` | `rgba(10,10,10,.55)` | `rgba(236,234,227,.58)` | secondary text |
| `--cd-faint` | `rgba(10,10,10,.4)` | `rgba(236,234,227,.4)` | tertiary / eyebrow text |

### Semantic accents

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--cd-green` / `--cd-green-soft` | `#1f8a4c` / `#dcefe4` | `#36ad6d` / 15% wash | **verified**, success, positive |
| `--cd-amber` / `--cd-amber-soft` | `#9a6b1f` / `#f5e8cf` | `#d99c3f` / 15% wash | **ID on file / attention** (not yet verified) |
| `--cd-flag` / `--cd-flag-soft` | `#c0392b` / `#f7e1dd` | `#e0604f` / 15% wash | **compliance flag / required / error** |
| `--cd-brass` / `--cd-brass-soft` | `#9a7406` / `#f3e7c8` | `#d9a92c` / wash | rate/board accent, used sparingly |

**Status-ladder semantics (KYC):** red = No ID / expired · **amber** = ID on file (held,
not verified) · **green** = verified. This mapping is load-bearing — don't recolour it.

## 3. Typography

Two families, loaded from Google Fonts:

- **Archivo** (400/500/600/700/800/900) — everything: UI, headings, body, numbers.
- **Space Mono** (400/700) — eyebrows, codes, tabular figures, timestamps, technical labels.

```css
font-family: 'Archivo', system-ui, sans-serif;      /* default */
font-family: 'Space Mono', monospace;               /* .mono — labels, codes, figures */
```

Type patterns seen across the build:
- **Eyebrow / label:** Space Mono, ~10px, `letter-spacing:.1em`, `text-transform:uppercase`, `--cd-faint`.
- **Section headline:** Archivo 800, 19–22px, `letter-spacing:-0.01em`.
- **Body:** Archivo 400–500, 12.5–14.5px, `line-height:1.5`.
- **Numbers / money:** `font-variant-numeric: tabular-nums` (always, for alignment).

## 4. Shape & elevation

- **Radii:** chips/inputs `8–10px` · cards/panels `11–14px` · pills/badges `999px`.
- **Borders:** 1px `--cd-line`; selected/emphasis 1.5px `#2B50E2`.
- **Shadows:** resting `0 1px 2px rgba(20,18,12,.04)`; raised card `0 12px 32px rgba(20,18,12,.10)`;
  **blue selection glow** `0 14px 36px rgba(43,80,226,.18)`; primary-CTA `0 6px 18px rgba(43,80,226,.32)`.

## 5. Iconography

Custom stroke icon set (`Ic` in `cdos-base.jsx`): 24×24 viewBox, `fill:none`,
`stroke:currentColor`, `stroke-width` ~1.6–2, round caps/joins. Render `<Ic n="name" s={size} c={color} />`.
Match this line weight for any new glyphs. No emoji anywhere in the product.

## 6. Theming contract

- One attribute switches everything: `document.documentElement.setAttribute('data-cdtheme', 'light'|'dark')`.
- Preference persists to `localStorage['cdos_theme']` (`light` / `dark` / `auto`) and is
  applied **before first paint** (inline script in the HTML head) to avoid a flash.
- New components: read `CD.<token>` (which resolves to `var(--cd-*)`) — never hardcode a
  hex except `#2B50E2`. That keeps dark mode free.

See `MOTION.md` for timing tokens, easing curves, and every animation's exact code.
