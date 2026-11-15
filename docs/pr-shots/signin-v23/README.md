# CD-221 first presentation candidate evidence

These are actual compiled OS components selected by the **test-only response
fixture**, not screenshots of copied static HTML. `manifest.json` records the
source/bundle/test SHA-256 digests, original base, fixed clock, locale and browser.

Five states × five sizes = 25 PNGs and 25 measurement JSONs. The 20 comparison
JSONs use the original supplied four-size reference. The 1100×700 compact size
has no supplied original, so it is checked for layout/scroll/accessibility only.
`docs/SIGNIN_V23.md` explains all named comparison exceptions and activation gaps.
The provider/OS-font/control/accessibility differences are intentional; no claim
of whole-pack or strict pixel-identical acceptance is made.

Pre-commit observed verification:

- `npm run build`, `npm run check:parse`, `npm run check:sanctions`: passed.
- `npm run typecheck --prefix server`: passed.
- Full server suite with fresh PostgreSQL16: 198 files / 2,007 tests passed, zero skips.
- Targeted browser suite: 17 passed, zero skips (10 new and seven existing).
- Axe on first/password/rejected-password at all five viewports: zero violations.
- Keyboard, reduced motion, real password-only server session, challenge handoff,
  duplicate-submit latch, network failure, lock, 503 and inactive URL flags: passed.
- T3 shared preview read the actual production components at 1100×700 and observed
  scroll/client height 700/700, with unavailable providers disabled. Two snapshot
  calls failed with “Preview automation snapshot timed out after 15000ms.” The
  PNG evidence here is from successful Playwright capture, not the failed tool.

The coordinator handoff records **post-commit** verification against the exact
candidate SHA. CI and independent review are pending. No merge or deployment,
and no external PR publication. This presentation slice is not all of CD-221.
