#!/usr/bin/env node
/* Boot `npm start` and require GET /api/health → 200.

   `npm start` is the live Render dashboard command (`tsx src/index.ts`).
   This does not compile and does not need dist/. It fails if that script
   is no longer tsx, or if a production install left tsx out.
*/
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const port = String(process.env.NPM_START_BOOT_PORT || 8792);
const timeoutMs = Number(process.env.NPM_START_BOOT_TIMEOUT_MS || 120_000);

if (!databaseUrl) {
  console.error("check-npm-start-boot: set TEST_DATABASE_URL or DATABASE_URL to a disposable Postgres.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(serverRoot, "package.json"), "utf8"));
if (pkg.scripts?.start !== "tsx src/index.ts") {
  console.error(`check-npm-start-boot: scripts.start is ${JSON.stringify(pkg.scripts?.start)}. The dashboard runs npm start, and that must stay tsx src/index.ts.`);
  process.exit(1);
}
if (!pkg.dependencies?.tsx) {
  console.error("check-npm-start-boot: tsx is not a runtime dependency. NODE_ENV=production npm ci would not install it.");
  process.exit(1);
}
if (!existsSync(path.join(serverRoot, "node_modules", ".bin", "tsx"))) {
  console.error("check-npm-start-boot: node_modules/.bin/tsx is missing.");
  process.exit(1);
}

const child = spawn("npm", ["start"], {
  cwd: serverRoot,
  detached: true,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    HOST: "127.0.0.1",
    PORT: port,
    DATABASE_URL: databaseUrl,
    SEED_PASSWORD: "npm-start-boot-check",
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

const stop = (signal) => {
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
};
process.on("exit", () => stop("SIGTERM"));
process.on("SIGINT", () => {
  stop("SIGTERM");
  process.exit(1);
});
process.on("SIGTERM", () => {
  stop("SIGTERM");
  process.exit(1);
});

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.error(logs);
    console.error(`check-npm-start-boot: server exited ${child.exitCode} before /api/health returned 200.`);
    process.exit(1);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.status === 200) {
      const body = await res.json();
      if (body?.ok === true && body?.service === "currencydesk-server") {
        console.log(`check-npm-start-boot: GET /api/health 200 ${JSON.stringify(body)}`);
        stop("SIGTERM");
        await delay(500);
        stop("SIGKILL");
        process.exit(0);
      }
    }
  } catch {
    /* not listening yet */
  }
  await delay(250);
}

console.error(logs);
console.error(`check-npm-start-boot: no /api/health 200 within ${timeoutMs}ms.`);
stop("SIGKILL");
process.exit(1);
