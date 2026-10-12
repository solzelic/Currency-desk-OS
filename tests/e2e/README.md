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
`tests/e2e/fonts/` (SIL Open Font License, `OFL.txt`). The spec serves
those files in place of `fonts.googleapis.com`. The same files are used
for the main capture and for the branch compare. A runner font change
does not move the pixels. A shot is refused if those faces did not load.

main-sha: 5216ef4780b750c2dcce5847296288920d63b443

Do not replace a PNG with a picture of a feature branch. A difference
means the desktop changed. The pixel rule is in
`tests/e2e/desktop-unchanged.spec.ts`.
