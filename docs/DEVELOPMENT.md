# Development

## Prerequisites

- Node.js 22 LTS or newer.
- npm 10 or newer.

This repository is validated with Node 22. The local validation branch installed Node through Homebrew at `/opt/homebrew/opt/node@22/bin`.

## Install

```sh
npm install
```

Use `npm ci` once `package-lock.json` exists and exact dependency versions should be reproduced.

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
