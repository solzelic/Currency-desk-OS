#!/usr/bin/env node
/* Boot the compiled server and require GET /api/health → 200.

   The caller compiles first (`npm run build` in server/). This script
   only starts `node dist/index.js` with cwd = server/, so migration SQL
   under src/ and STATIC_DIR=.. resolve the same way they do on Render.
   It does not compile, and it fails while dist/index.js is absent.
*/
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(serverRoot, "dist", "index.js");
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const port = String(process.env.DIST_BOOT_PORT || 8791);
const timeoutMs = Number(process.env.DIST_BOOT_TIMEOUT_MS || 120_000);

if (!databaseUrl) {
  console.error("check-dist-boot: set TEST_DATABASE_URL or DATABASE_URL to a disposable Postgres.");
  process.exit(1);
}
if (!existsSync(entry)) {
  console.error("check-dist-boot: server/dist/index.js is missing. Compile with `npm run build` in server/ first.");
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  cwd: serverRoot,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    HOST: "127.0.0.1",
    PORT: port,
    DATABASE_URL: databaseUrl,
    SEED_PASSWORD: "dist-boot-check",
    RATES_SYNC: "off",
    STATIC_DIR: "..",
    STATIC_INDEX: "CurrencyDesk OS.html",
    SITE_INDEX: "web/index.html",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
const capture = (chunk) => {
  logs += chunk.toString();
  if (logs.length > 200_000) logs = logs.slice(-100_000);
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

const stop = () => {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(1);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(1);
});

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.error(logs);
    console.error(`check-dist-boot: server exited ${child.exitCode} before /api/health returned 200.`);
    process.exit(1);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.status === 200) {
      const body = await res.json();
      if (body?.ok === true && body?.service === "currencydesk-server") {
        console.log(`check-dist-boot: GET /api/health 200 ${JSON.stringify(body)}`);
        stop();
        await delay(500);
        if (child.exitCode === null) child.kill("SIGKILL");
        process.exit(0);
      }
    }
  } catch {
    /* not listening yet */
  }
  await delay(250);
}

console.error(logs);
console.error(`check-dist-boot: no /api/health 200 within ${timeoutMs}ms.`);
stop();
process.exit(1);
