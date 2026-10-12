# Desktop pictures

The PNGs in `desktop-unchanged.spec.ts-snapshots/` are the 1280×800 desk
rendered from one commit on main. They are not a render of this branch.

`scripts/capture-main-desktop-baselines.mjs` checks that commit out and
captures it in the browser-seam job: `ubuntu-latest`, Node from `.nvmrc`,
Playwright Chromium installed with `npx playwright install --with-deps
chromium`, and the `postgres:16` service container. The same job renders
that commit twice and keeps the pictures only when the two renders match.
The branch is then compared to them.

main-sha: 9f1efb81f285a69e1b0d30ee2f092e9734342a08

Do not replace a PNG with a picture of a feature branch. A difference
means the desktop changed. The pixel rule is in
`tests/e2e/desktop-unchanged.spec.ts`.
