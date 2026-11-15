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

Review correction evidence:

- The five new keystroke/recovery regression cases failed on e847 before fixes.
- Corrected-source targeted browser suite: 28 passed, zero skips (21 v2.3 and
  seven existing). This includes an actual server-issued legacy CD-ID login
  and real server-created maryjane/adam-west/cdbeckham7 accounts. All three
  reproduced401 on08818d95 before removing normalization from Continue.
- Axe on first/password/rejected-password at all five viewports: zero violations.
- Missing reference elements now fail except the documented provider stand-in
  and absent shop lede. Reports and assertions use identical semantic matching;
  geometry exceptions no longer suppress font/colour assertions. Tap targets
  check width and height on both screens. Wrong-password clearing is asserted.
- ID captures show formatting after blur, with keyboard focus on Continue.
  The raw text returns on focus; select-all replacement and later @ are tested.
  Continue/password identity/request preserve the typed value; the display
  formatter has no authority to choose an account.
- Reset/cooldown text is retained; busy progress is a neutral status.
  The per-second countdown is outside the live region (red-first regression).

The e847 and08818d95 server2007/2007 and ledger61/61 passes are historical
only; both full browser runs were interrupted following review rejection. The successor's full suites, CI and fresh independent review are pending;
its exact-commit results belong in the signed ticket/PR handoff. No merge or
deployment is claimed. This presentation slice is not all of CD-221.

Prior shared preview observed 1100×700 without scroll. Its snapshot calls twice
failed with “Preview automation snapshot timed out after 15000ms.” The images
here are successful Playwright captures, regenerated with the corrected source.
