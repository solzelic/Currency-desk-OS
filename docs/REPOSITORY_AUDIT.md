# Repository Audit

Audit date: 2026-07-11

## Git

- Path: `/Users/jakobsubotic/Downloads/Currency desk OS prototype V1`
- Default branch observed locally: `main`
- Working branch for foundation work: `develop/frontend-foundation`
- Remote: `https://github.com/solzelic/Currency-desk-OS`

## Existing Structure

- Root HTML files contain runnable demos and reference pages.
- `os-src/` contains the buildless React/Babel OS prototype modules.
- `YorkFX/` contains public-site and rate-board assets/pages.
- `design_handoff_kyc/` contains the KYC developer handoff.
- `docs/` contains handoff/session context and roadmap material.
- `screenshots/` and `uploads/` contain visual proof, media, source uploads, and reference assets.

## Size Notes

Approximate local sizes observed:

- Repository: 195M
- `uploads/`: 72M
- `YorkFX/`: 25M
- `screenshots/`: 8.4M
- `os-src/`: 1.4M

Large files observed over 5M:

- `uploads/York FX homepage video.mp4`
- `uploads/Screenshot 2026-06-20 at 10.32.09 PM.png`

## Dependency State

Before this foundation work, the repo had no package manager manifest, lockfile, bundler config, or TypeScript config. The prototype depends on CDN-loaded React, ReactDOM, Babel standalone, Tailwind CDN, and Google Fonts.

## Architecture Observations

- The prototype uses `window.CDOS` as a global namespace and relies on script load order.
- Domain logic and UI are interleaved in JSX modules.
- Demo persistence is localStorage based.
- The KYC, compliance, transaction, receipt, and till concepts are already represented well enough to drive a production rebuild.

## Repository Hygiene Recommendations

- Keep prototype/demo exports tracked for now because they are the current product artifact.
- Avoid committing `node_modules`, `dist`, local env files, coverage, or Vite cache output.
- Consider Git LFS later for large media if this repository continues to carry videos and heavy screenshots.
- Add automated checks for the new TypeScript foundation before migrating prototype modules.
