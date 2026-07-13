// local secrets (OXR_APP_ID etc.) — server/.env is gitignored; in production
// these come from the host's environment (Render dashboard)
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* no .env — fine */
}

import { createDb } from "./db/index.js";
import { seed, DEMO } from "./seed.js";
import { buildApp } from "./app.js";
import { syncMarketRates } from "./rates/market.js";

const handle = await createDb();
// seed on every boot — it's idempotent (onConflictDoNothing throughout), so
// an empty database gets the demo tenant/staff/board and an existing one is
// untouched. First boot on Render provisions Neon automatically this way.
await seed(handle.db);

const app = await buildApp(handle.db);
const port = Number(process.env.PORT ?? 8787);
// bind all interfaces in production (Render/Railway route external traffic);
// loopback-only in dev
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port, host });
console.log(`currencydesk-server on http://${host}:${port}`);

// live market rates: pull on boot, then hourly (RATES_SYNC_MINUTES to change;
// RATES_SYNC=off to disable). Provider is keyless by default; set OXR_APP_ID
// for hourly-updated data from openexchangerates.org.
if (process.env.RATES_SYNC !== "off") {
  const minutes = Number(process.env.RATES_SYNC_MINUTES ?? 60);
  const run = async () => {
    const r = await syncMarketRates(handle.db, DEMO.branchId);
    console.log(`[rates-sync] ${r.ok ? "ok" : "FAILED"} — ${r.detail}`);
  };
  void run();
  setInterval(run, minutes * 60 * 1000).unref();
}
