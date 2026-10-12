# Desktop pictures

The PNGs in `desktop-unchanged.spec.ts-snapshots/` are the 1280×800 desk
rendered from one commit on main. They are not a render of this branch.

`scripts/capture-main-desktop-baselines.mjs` checks that commit out and
captures it in the browser-seam job: `ubuntu-latest`, Node from `.nvmrc`,
Playwright Chromium installed with `npx playwright install --with-deps
chromium`, and the `postgres:16` service container. The same job renders
that commit twice, and all 13 pictures have to match at every pixel.
The sign-in card keeps its glass in the product. The capture turns
`backdrop-filter` off for that shot only: two renders of main with the
blur on differed by 4 pixels at channel delta 1, and then by 6 pixels
at channel delta 8 after the entrance was paused and the blur had been
waited on. The shot also pauses animations, hides the caret, waits for
`document.fonts.ready`, and requires device scale 1. The branch is then
compared to that render with the same rule.

The text in that picture is Archivo and Space Mono from
`tests/e2e/fonts/` (SIL Open Font License, `OFL.txt`). U+2192, U+2265,
U+25B2, and U+25BC are not in those latin files. The capture serves
them from DejaVu Sans on Archivo and DejaVu Sans Mono on Space Mono
(`DEJAVU.txt`). The menu-bar rate ticker and the ledger sort mark are ▲ or ▼.
Left to the machine, those marks are a different glyph off CI, and
every open-desk picture moves. The spec serves those files in place of
`fonts.googleapis.com`, for the main capture and for the branch
compare. The runner's fontconfig is not a face in the picture. The
browser zone is UTC, so the pinned 15:02Z clock paints 15:02. A shot
is refused if those faces did not load, including the arrow, the
greater-or-equal sign, and the sort triangles.

main-sha: 5216ef4780b750c2dcce5847296288920d63b443

The committed pictures are a two-pass render of that commit, taken
with these faces. The seam job renders the same commit again and
refuses the pictures when they differ.

Do not replace a PNG with a picture of a feature branch. A difference
means the desktop changed. The pixel rule is in
`tests/e2e/desktop-unchanged.spec.ts`.
