# Desktop pictures

The PNGs in `desktop-unchanged.spec.ts-snapshots/` are the 1280×800 desk
rendered from one commit on main. They are not a render of this branch.

`scripts/capture-main-desktop-baselines.mjs` checks that commit out and
captures it in the browser-seam job: `ubuntu-latest`, Node from `.nvmrc`,
Playwright Chromium installed with `npx playwright install --with-deps
chromium`, and the `postgres:16` service container. The same job renders
that commit twice. Twelve pictures have to match at every pixel. Sign-in
may differ by at most 10 pixels, and only by one level in a channel.
Browser-seam run 38225974487 rendered main `5216ef4` twice with animations
paused, the caret hidden, the desk fonts loaded, and the shot in CSS
pixels. Sign-in still differed by 4 pixels, max channel delta 1, and
nothing else moved. The glass blur and shadow are what move. The shot
waits until that blur and shadow are applied and the device scale is 1.
A channel gap of 2 or more, or an 11th pixel, fails. The branch is then
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
