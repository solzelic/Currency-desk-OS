# CurrencyDesk OS — Motion & Timing

The complete motion language of the product, pulled from the live build. Drop this
into the **Motion** section of the brand guidelines. Every value below is the exact
value shipping in the app (`york-os.css`, `cdos-base.jsx`, `cdos-kyc.jsx`, `yorkfx-staff.js`).

Two rules govern everything:

1. **Motion is quick and understated.** UI feedback lives in the **100–200 ms** band;
   nothing decorative runs longer than ~0.4 s. Ambient loops (pulses, ticker) are the
   only long-running motion.
2. **Respect `prefers-reduced-motion`.** Every looping/decorative animation is disabled
   under reduced-motion. Keep this contract when implementing.

---

## 1. Timing tokens

Suggested token names → the exact durations already in use.

| Token | Value | Where it's used |
|---|---|---|
| `--motion-instant` | `70ms` | button press (`transform`) |
| `--motion-micro` | `100–130ms` | hovers: dock ops, window chrome, calculator keys, menu rows |
| `--motion-fast` | `150ms` | most hovers: inputs, branch cards, nav, chips |
| `--motion-base` | `180ms` | commit-button background, badge pop |
| `--motion-window` | `160ms` | window open (opacity + transform) |
| `--motion-select` | `280ms` | **tier / card selection** (KYC chooser, pricing cards) |
| `--motion-pop` | `360ms` | brand click-pop on permanent actions |

### Easing tokens

| Token | Value | Feel / use |
|---|---|---|
| `--ease-standard` | `ease` / `ease-out` | default for hovers & fades |
| `--ease-select` | `cubic-bezier(.2,.9,.3,1.2)` | card lift on select — slight overshoot |
| `--ease-pop` | `cubic-bezier(.34,1.56,.64,1)` | springy confirm pop (overshoots then settles) |
| `--ease-in-hard` | `cubic-bezier(.4,0,1,1)` | element leaving / collapsing (icon removal) |

```css
:root {
  --motion-instant: 70ms;
  --motion-micro:  120ms;
  --motion-fast:   150ms;
  --motion-base:   180ms;
  --motion-window: 160ms;
  --motion-select: 280ms;
  --motion-pop:    360ms;

  --ease-standard: cubic-bezier(0.4, 0.0, 0.2, 1);
  --ease-select:   cubic-bezier(0.2, 0.9, 0.3, 1.2);
  --ease-pop:      cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-in-hard:  cubic-bezier(0.4, 0.0, 1, 1);
}
```

---

## 2. Signature interactions

### 2a. Card / tier selection  ← the KYC pricing + verification chooser
The hero interaction. On select: blue border, soft blue glow, a small lift + scale,
and unselected cards dim. Icon tile and price recolor to brand blue `#2B50E2`.

```css
transition: transform .28s cubic-bezier(.2,.9,.3,1.2),
            box-shadow .28s ease,
            border-color .28s ease,
            opacity .28s ease;

/* selected */
border: 1.5px solid #2B50E2;
box-shadow: 0 16px 40px rgba(43,80,226,.20);
transform: translateY(-6px) scale(1.02);
opacity: 1;

/* unselected */
border: 1px solid var(--cd-line);
box-shadow: 0 1px 2px rgba(20,18,12,.04);
transform: none;
opacity: .8;
```
Feature rows inside a selected card fade in with a **55 ms stagger** per row
(`transition: opacity .35s ease Ns`, where N = index × 55 ms).

### 2b. Commit / permanent-action button (arm → fire)
Buttons that write an immutable record use a two-state background swap plus a spring
"pop" the moment the action commits.

```css
/* button base */
transition: background .18s ease, transform .07s ease;

/* the pop, played once on commit */
@keyframes fxPop { 0% { transform: scale(1); } 32% { transform: scale(0.93); } 100% { transform: scale(1); } }
.fx-pop { animation: fxPop 0.36s cubic-bezier(.34,1.56,.64,1); }
```

### 2c. Window open
App windows fade + rise into place.

```css
.win {
  opacity: 0;
  transform: translateY(6px) scale(0.99);
  transition: opacity .16s ease, transform .16s ease, box-shadow .2s ease;
}
.win.show { opacity: 1; transform: none; }
.win.dragging { transition: none; }   /* no lag while dragging */
```

### 2d. Menu / popover open
```css
animation: mb-menu-in 0.14s ease-out;
@keyframes mb-menu-in {
  from { opacity: 0; transform: translateY(-5px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

### 2e. Hover language (reference band)
- Inputs, branch cards, nav, chips: `transition: … .15s`
- Dock ops, window chrome, calculator keys, menu rows: `.12s–.13s`
- Button press feedback: `transform .07s–.1s`

---

## 3. Ambient loops (decorative — gate on reduced-motion)

### 3a. Live pulse dot (rates ticker "HOURLY", AI status)
```css
.tk-pulse { animation: tkPulse 1.8s ease-out infinite; }
@keyframes tkPulse {
  0%  { box-shadow: 0 0 0 0 rgba(255,255,255,0.8); }
  70% { box-shadow: 0 0 0 5px rgba(255,255,255,0); }
  100%{ box-shadow: 0 0 0 0 rgba(255,255,255,0); }
}

.ai-dot { animation: ai-pulse 1.8s infinite; }
@keyframes ai-pulse {
  0%  { box-shadow: 0 0 0 0 rgba(47,158,111,0.5); }
  70% { box-shadow: 0 0 0 6px rgba(47,158,111,0); }
  100%{ box-shadow: 0 0 0 0 rgba(47,158,111,0); }
}
```

### 3b. Rate ticker scroll
```css
@keyframes tickerScroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.mb-ticker:hover .mb-ticker-track { animation-play-state: paused; }  /* pause on hover */
@media (prefers-reduced-motion: reduce) { .mb-ticker-track { animation: none; } }
```

### 3c. Alert bell — breathe + ring (severity-rated)
Rate is set per severity: hi `0.85s`, mid & lo slower.
```css
.bell-dot.sig-hi { animation: bellBreathe var(--bd-rate) ease-in-out infinite; --bd-rate: 0.85s; }
@keyframes bellBreathe {
  0%,100% { transform: scale(0.82); opacity: 0.55; }
  50%     { transform: scale(1.15); opacity: 1; }
}
.bell-dot::after { animation: bellRing var(--bd-rate) ease-out infinite; }
@keyframes bellRing {
  0%  { transform: scale(1);   opacity: 0.5; }
  70% { transform: scale(2.6); opacity: 0;   }
  100%{ transform: scale(2.6); opacity: 0;   }
}
```

### 3d. Bell glyph — Morse "SOS" blink (header, when attention needed)
```css
.bell-head-ic.morse { animation: bellMorse 3s steps(1, end) infinite; }
/* opacity keyframes spell S-O-S in morse; see york-os.css @keyframes bellMorse */
```

### 3e. AI typing indicator (three bouncing dots)
```css
.ai-typing span { animation: ai-bounce 1s infinite; }
.ai-typing span:nth-child(2) { animation-delay: 0.15s; }
.ai-typing span:nth-child(3) { animation-delay: 0.30s; }
@keyframes ai-bounce { 0%,60%,100% { transform: translateY(0); opacity:.5; } 30% { transform: translateY(-4px); opacity:1; } }
```

### 3f. KYC verification spinner (check running)
```css
@keyframes kycspin { to { transform: rotate(360deg); } }
.kyc-spin { animation: kycspin 0.8s linear infinite; }
```

---

## 4. Editing / dock manipulation (iOS-style)

### 4a. Jiggle while rearranging the dock
```css
@keyframes cdos-jiggle {
  0%   { transform: rotate(-1.15deg) translateY(-0.3px); }
  50%  { transform: rotate(1.15deg)  translateY(0.3px); }
  100% { transform: rotate(-1.15deg) translateY(-0.3px); }
}
.app-btn.jiggle { animation: cdos-jiggle 0.34s infinite ease-in-out; transform-origin: 50% 50%; }
/* alternating phase + slightly different durations per child so the row feels organic */
.app-btn.jiggle:nth-child(2n) { animation-name: cdos-jiggle-alt; animation-duration: 0.39s; }
.app-btn.jiggle:nth-child(3n) { animation-duration: 0.31s; }
```

### 4b. Dragged icon lifts
```css
.app-btn.dragging { transform: scale(1.07) !important; box-shadow: 0 10px 24px -6px rgba(10,10,10,0.32); animation: none !important; }
```

### 4c. Icon removed (pops out toward the Store)
```css
@keyframes cdos-remove { 0% { transform: scale(1); opacity: 1; } 60% { transform: scale(0.55); opacity: 0.4; } 100% { transform: scale(0.1); opacity: 0; } }
.app-btn.removing { animation: cdos-remove 0.28s cubic-bezier(0.4,0,1,1) forwards !important; }
```

### 4d. Badge pop-in
```css
@keyframes cdos-badge-pop { from { transform: scale(0.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.app-badge { animation: cdos-badge-pop 0.18s ease-out; }
```

---

## 5. Reduced-motion contract

Every decorative loop above is wrapped in:

```css
@media (prefers-reduced-motion: reduce) {
  /* pulses, ticker, jiggle, bell breathe/ring/morse → animation: none */
}
```

Selection, window-open and menu-open fades are kept (they're short and informational),
but avoid the overshoot easings under reduced-motion — swap `--ease-select` /
`--ease-pop` for `--ease-standard` and drop the `translateY/scale` on entrances.

---

### Quick reference — "what moves and for how long"
- **Press** 70 ms · **Hover** 120–150 ms · **Badge/commit** 180 ms · **Window/menu** 140–160 ms · **Card select** 280 ms · **Confirm pop** 360 ms
- **Loops** (pulse 1.8 s · ticker linear · bell 0.85 s · spinner 0.8 s) — all off under reduced-motion.
