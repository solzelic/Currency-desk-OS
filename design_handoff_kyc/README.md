# CurrencyDesk OS — Developer Handoff

The operating system for a currency-exchange / money-services desk: live rate board,
transaction ledger, transfers, cheque cashing, client KYC, compliance (LCTR / alerts),
till & vault cash management, multi-branch, reports, and an in-app module store.

This package is the source of truth for a production rebuild. It is a **working
prototype**, not production code — see *Rebuild notes* below for what to keep vs. replace.

---

## 1. What's here

```
CurrencyDesk OS.html          ← entry point (dev; loads .jsx via Babel from CDN)
CurrencyDesk OS (standalone).html  ← self-contained demo (all source inlined; open & run offline*)
cdos-*.jsx                    ← the app, one file per domain (see §3)
yorkfx-converter.js           ← live rate engine (reads the published/locked rate board)
york-os.css, yorkfx.css       ← desk styling + design tokens
BRAND.md                      ← colour, type, spacing tokens
MOTION.md                     ← every animation with exact code
KYC Nudge States.html         ← standalone reference: every verification state + the pricing tiers
```
\* the standalone still pulls Tailwind + fonts from CDN at runtime; those can't be inlined.

## 2. Running the prototype

It's a **buildless React app**: React 18 + Babel-standalone transpile the `.jsx` in the
browser. No npm, no bundler.

- Open `CurrencyDesk OS.html` from a local static server (any: `python -m http.server`,
  VS Code Live Server, etc.). Opening via `file://` works for most browsers but a server
  is safer for the font/CDN preconnects.
- **Sign in:** any staff ID from the seed (`a.singh`, etc.), password anything, 2FA is
  pre-filled `000000`. Pick a branch/till → workspace.
- State persists to **localStorage** (keys prefixed `cdos_`). To reset the demo cast:
  Settings → Business → *Reset demo data*, or clear `cdos_*` keys.

## 3. Architecture

Everything hangs off a single global, **`window.CDOS`**, populated by `cdos-base.jsx`
first, then extended by each module. There is no module system — load order (defined in
`CurrencyDesk OS.html`) *is* the dependency graph. `cdos-base.jsx` must load first and
`cdos-os.jsx` (the shell) last.

| File | Responsibility |
|---|---|
| `cdos-base.jsx` | **Foundation.** `CD` colour tokens + theme injector, `Ic` icon set, seed data (staff, clients, rows), helpers (`fmt`, rate bridge, `TODAY`), light/dark controller. Everything else reads from here. |
| `cdos-infotip.jsx` | Tooltip / info-popover primitive. |
| `cdos-modules.jsx` | Shared module chrome + the client KYC-status ladder (`missing ID → ID on file → verified`). |
| `cdos-settings.jsx` | Store profile, receipt text, timezone, staff & permissions, billing/plan, **partner authorization code** (buried KYC discount). |
| `cdos-dashboard.jsx` | Day-view dashboard (volume, margin, alerts). |
| `cdos-till.jsx` / `cdos-vault.jsx` | Teller drawer reconcile / vault + wholesale cash position. |
| `cdos-branches.jsx` | Multi-branch network + inter-branch movements. |
| `cdos-clients.jsx` | Client profiles, ID docs, KYC status badges, per-client history. |
| `cdos-search.jsx` | Global search. |
| `cdos-ledger.jsx` + `cdos-txmodal.jsx` | Transaction book + the New-Transaction modal (where the KYC nudge fires). |
| `cdos-transfers*.jsx` | Remittance corridors, beneficiaries, transfer flow. |
| `cdos-cheques*.jsx` | Cheque-cashing desk. |
| `cdos-compliance*.jsx` + `cdos-lctr.jsx` | Flag engine, alerts, LCTR obligations. |
| `cdos-kyc.jsx` | **The verification rail.** Tiers, pricing, smart routing, the recommendation nudge, SendModal chooser, partner-code discount. See §4. |
| `cdos-apps.jsx` | Utilities (calculator, loan calc, AI assistant, tagged) + module Store. |
| `cdos-reports.jsx` / `cdos-pricing.jsx` / `cdos-import.jsx` | Reports, rate strategy, CSV import. |
| `cdos-os.jsx` | **The shell.** Desktop, dock, window manager, sign-in/lock, rate ticker. Renders `window.CDOS_App`. |
| `yorkfx-converter.js` | Plain-JS rate engine shared with the public YorkFX site; the OS rate board reads/writes through it. |

## 4. The KYC verification system (the core IP)

Three tiers, priced to convert (full rationale on the `KYC Nudge States.html` page):

| Tier | Price | What it runs |
|---|---|---|
| **Quick check** | $3.99 | Re-screen of an already-verified client. **Smart-routed:** checks our own file first; only re-buys the sanctions/watchlist screen if stale. *Hidden until the client is verified.* |
| **Verified** | $6.99 | Full KYC — ID authentication + database cross-check + sanctions/PEP screen. Sets the green badge. Required for every first contact. |
| **Verified Plus** | $14.99 | Enhanced due diligence — adds biometric selfie/liveness, adverse media, phone/email risk. For large deals & high-risk profiles. |

**Status ladder (badges):** `No ID` (red) → `ID on file` (amber, scanned/typed but no KYC)
→ `ID verified` / `Verified Plus` (green). Amber ≠ verified — a Quick check does **not**
turn the badge green.

**The recommendation nudge** (`VerificationNudge` in `cdos-kyc.jsx`) reads a client's
state + house parameters and recommends exactly one tier:
- never verified → **Verified** · verified but stale >180d → **Quick** · high-risk → escalates to **Plus**
- ID expired, or a deal legally needs a verified ID and the file isn't → **forcing** (red, can't dismiss)

House parameters (tunable): `recheckDays` 180, `reverifyDays` 365, ID-required threshold,
mandatory-check-on-large-deals toggle. Recommendation = **blue** (#2B50E2); hard stop = red.

**Public API** (all on `window.CDOS.KYC`): `TEMPLATES`, `summary`, `checksFor(name)`,
`VerificationNudge`, `SendModal`, `SubjectPanel`, `applyPartnerCode(code)`,
`getPartnerRate()`, `setProvider/getProvider`.

**Partner authorization code** — a buried lifetime discount for founding desks
(Settings → Compliance *or* Billing, collapsible "Have a partner authorization code?").
Codes: `YFX-FOUNDER` 10%, `YFX-PARTNER` 7%, `YFX-INTRO` 5%. Applied to every check via
`net(price)`. Never labelled "discount" in the UI.

## 5. Rebuild notes (prototype → production)

**Keep** (this is the designed product): the tier model & pricing, the smart-routing
logic, the status ladder, the nudge decision tree, the forcing rules, the whole
visual/motion language (see BRAND.md + MOTION.md), the screen layouts.

**Replace / build for real:**
- **Persistence:** localStorage → real backend + DB. All `cdos_*` keys are the data model
  sketch; treat them as a schema starting point, not a spec.
- **KYC provider:** the check flow is simulated (`reconcile()` fakes async completion).
  Wire to the real provider API (configured in Settings). Keep `net()` for pricing.
- **Auth:** the sign-in / 2FA is a mock. Real IdP + session management.
- **Buildless React:** fine for a prototype; for production move to a real build
  (Vite/Next), a module system, and TypeScript. The `window.CDOS` global pattern should
  become proper imports; component boundaries already map cleanly to the file list in §3.
- **Compliance filings (LCTR etc.):** logic is modeled but must be validated against
  current FINTRAC (and per-jurisdiction) requirements before going live.

See `BRAND.md` and `MOTION.md` for the complete design token + animation spec.
