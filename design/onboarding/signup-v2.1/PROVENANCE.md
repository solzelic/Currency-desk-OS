# Sign-up / onboarding v2.1 — where this design came from

Sol's pack "ob-1-core" (design canvas "Sign-up / onboarding, v2.1", frozen 14 Nov 2026),
copied here unchanged on 15–16 Nov 2026 by Claude Code (Opus 5.5) for CD-206.

| File here | From the pack | sha256 |
|---|---|---|
| `CurrencyDesk Sign-up v2.1.dc.html` | `reference/prototype/index.html` | `2451a3cd32c498d695f3cd1e1346c3628e2a06db8e61a66188fa95b3f733d614` |
| `flags/*.svg` | `reference/prototype/assets/flags/` | byte-identical copies |
| `shots/*` | `reference/prototype/coded/shots/` | byte-identical copies (placeholder clips, see below) |

Not copied, because the repository already holds identical files: `reference/prototype/support.js`
(= `design/site/support.js`, sha256 `8fe7df74…cbe`), the React 18.3.1 production builds
(= `web/vendor/`), and the fonts (= `web/fonts/`, which differ only in absolute paths).
Deliberately not copied: `coded/demo-mode.js` (the fake server, sha256 `aa55df43…250`).

Pack documents read alongside: `BUILD-SIGNUP-ONBOARDING.md` (sha256 `8c916b1b…93c9`),
`reference/SIGNUP-LOGIC.md` (sha256 `1cc9b49d…827f`), `reference/tools/capture.cjs`
(sha256 `b642ff91…87dc`).

## Rules

- **Do not edit the design file.** `scripts/build-signup.mjs` changes it on the way to
  `web/signup.html`, with every change asserted. A new export from the designer replaces the
  file; the build then fails on any anchor that moved, which is the point.
- The service agreement text in this file is pinned by hash on the server
  (`SERVICE_AGREEMENT_SOURCE_HASH`, `server/src/onboarding/signup-open.ts`); the build refuses
  a file whose agreement differs. Changing it needs Compliance.
- `shots/` are the designer's placeholder clips. The build doc asks for real screen recordings of
  the shipped desk at the same aspect; until those are produced, these are what the tour plays.

## Baselines

The pack's `reference/screens/` folder was absent. Baselines were regenerated from this exact
prototype with the pack's own `capture.cjs` (one local addition: a `check` size of 1440×900 and an
`ONLY=` filter for re-capturing named states), served by `python3 -m http.server` from the pack's
`reference/prototype/`, `?bare=1`, Chromium 1228 (Playwright 1.61.1), fixed clock 13 Nov 2026
2:00 pm America/Toronto. They live outside the repository (CD-206 evidence), not here.
