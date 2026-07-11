# Development

## Prerequisites

- Node.js 22 LTS or newer.
- npm 10 or newer.

This machine did not have `node` or `npm` on PATH during the foundation setup, so the first dependency install and toolchain validation still need to be run in an environment with Node available.

## Install

```sh
npm install
```

The install should create `package-lock.json`. Commit the lockfile after the first successful install.

## Run

```sh
npm run dev
```

Open the Vite app at the URL printed by Vite. The entry point is `frontend.html`.

## Check

```sh
npm run check
```

`npm run check` runs TypeScript and production build validation for the new frontend foundation. It does not validate or rebuild the preserved prototype.
