#!/usr/bin/env node
/* Boot the compiled server and post the 3,500 USD quote.

   The caller compiles first (`npm run build` in server/). This script
   only starts `node dist/index.js` with cwd = server/, so migration SQL
   under src/ and the shared quote module at ../../../os-src/quote-terms.js
   resolve the same way they do when start:dist is the process. A tsc
   rootDir gap fails here, on the quote, not at GET /api/health.

   render.yaml on main still starts with `npm start` (tsx). This is the
   compiled path that start command will run once the server is built.
*/
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(serverRoot, "dist", "index.js");
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const port = String(process.env.DIST_BOOT_PORT || 8799);
const timeoutMs = Number(process.env.DIST_BOOT_TIMEOUT_MS || 120_000);
const password = "dist-boot-check";

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
    SEED_PASSWORD: password,
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

const fail = (message) => {
  console.error(logs);
  console.error(message);
  stop();
  process.exit(1);
};

const base = `http://127.0.0.1:${port}`;

async function request(url, options = {}, cookie = "") {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + url, { ...options, headers });
  const text = await res.text();
  const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const next = set.map((line) => line.split(";")[0]).filter(Boolean);
  const jar = [...cookie.split("; ").filter(Boolean), ...next];
  return { status: res.status, text, cookie: jar.join("; ") };
}

const deadline = Date.now() + timeoutMs;
let health = null;
while (Date.now() < deadline) {
  if (child.exitCode !== null) fail(`check-dist-boot: server exited ${child.exitCode} before /api/health returned 200.`);
  try {
    const res = await request("/api/health");
    if (res.status === 200) {
      const body = JSON.parse(res.text);
      if (body?.ok === true && body?.service === "currencydesk-server") {
        health = body;
        break;
      }
    }
  } catch {
    /* not listening yet */
  }
  await delay(250);
}
if (!health) fail(`check-dist-boot: no /api/health 200 within ${timeoutMs}ms.`);
console.log(`check-dist-boot: GET /api/health 200 ${JSON.stringify(health)}`);

const login = await request("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ staffId: "r.haddad", password, tenantId: "tnt-yorkfx" }),
});
if (login.status !== 200) fail(`check-dist-boot: login ${login.status} ${login.text}`);

const customer = await request("/api/ledger/customers", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Boot Quote", risk: "normal", idStatus: "verified" }),
}, login.cookie);
if (customer.status !== 201) fail(`check-dist-boot: customer ${customer.status} ${customer.text}`);
const customerId = JSON.parse(customer.text).customerId;
if (!customerId) fail(`check-dist-boot: customer response had no customerId ${customer.text}`);

const opened = await request("/api/ledger/till-sessions/open", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
}, customer.cookie);
if (opened.status !== 201 && opened.status !== 409) fail(`check-dist-boot: till open ${opened.status} ${opened.text}`);

const balances = await request("/api/ledger/opening-balances", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ balances: { CAD: "25000.00", USD: "12000.00" } }),
}, opened.cookie);
if (balances.status !== 201 && balances.status !== 409) fail(`check-dist-boot: opening balances ${balances.status} ${balances.text}`);

const quote = await request("/api/quotes", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    customerId,
    from: "USD",
    to: "CAD",
    inputAmount: "3500.00",
    feeCad: "0.00",
    direction: "customer_sell_foreign",
  }),
}, balances.cookie);
if (quote.status !== 201) fail(`check-dist-boot: quote ${quote.status} ${quote.text}`);
const frozen = JSON.parse(quote.text);
if (frozen.outputAmount !== "4702.63") {
  fail(`check-dist-boot: quote output ${frozen.outputAmount}, expected 4702.63. ${quote.text}`);
}

const posted = await request(`/api/quotes/${frozen.quoteId}/post`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    idempotencyKey: "dist-boot-3500",
    purpose: "Personal travel",
    sourceOfFunds: "Employment income",
    shownAmount: frozen.outputAmount,
  }),
}, quote.cookie);
if (posted.status !== 201) fail(`check-dist-boot: post ${posted.status} ${posted.text}`);
const row = JSON.parse(posted.text);
if (row.outputAmount !== "4702.63") {
  fail(`check-dist-boot: posted output ${row.outputAmount}, expected 4702.63. ${posted.text}`);
}

console.log(`check-dist-boot: POST /api/quotes outputAmount ${frozen.outputAmount}; posted ${row.outputAmount}`);
stop();
await delay(500);
if (child.exitCode === null) child.kill("SIGKILL");
process.exit(0);
