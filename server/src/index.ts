// local secrets (OXR_APP_ID etc.) — server/.env is gitignored; in production
// these come from the host's environment (Render dashboard)
try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {
  /* no .env — fine */
}

import { and, eq } from "drizzle-orm";
import { createDb, schema } from "./db/index.js";
import { seed, DEMO } from "./seed.js";
import { buildApp } from "./app.js";
import { syncMarketRatesIfStale } from "./rates/market.js";
import { refreshSiteDomains } from "./sites.js";
import { hashPassword } from "./auth/password.js";
import { revokeAllSessions } from "./auth/sessions.js";
import { audit } from "./audit.js";

const handle = await createDb();
// seed on every boot — it's idempotent (onConflictDoNothing throughout), so
// an empty database gets the demo tenant/staff/board and an existing one is
// untouched. First boot on Render provisions Neon automatically this way.
await seed(handle.db);

// break-glass recovery: RESET_STAFF_PASSWORD="staffId:newpassword" resets one
// account at boot (audited, marked temporary). For the day an owner is locked
// out — set it in the Render dashboard, sign in, then REMOVE the env var:
// while it is set, every boot repeats the reset.
if (process.env.RESET_STAFF_PASSWORD) {
  const [staffId, ...rest] = process.env.RESET_STAFF_PASSWORD.split(":");
  const password = rest.join(":");
  if (staffId && password.length >= 8) {
    const rows = await handle.db
      .select()
      .from(schema.staffUsers)
      .where(and(eq(schema.staffUsers.tenantId, DEMO.tenantId), eq(schema.staffUsers.staffId, staffId)))
      .limit(1);
    const user = rows[0];
    if (user) {
      await handle.db
        .update(schema.staffUsers)
        .set({ passwordHash: await hashPassword(password), mustChangePassword: true, passwordUpdatedAt: new Date(), active: true })
        .where(eq(schema.staffUsers.id, user.id));
      await revokeAllSessions(handle.db, user.id);
      await audit(handle.db, {
        tenantId: user.tenantId,
        legalEntityId: user.legalEntityId,
        branchId: user.branchId,
        actorId: null,
        action: "staff.password_reset",
        detail: { staffId, via: "RESET_STAFF_PASSWORD env (break-glass)" },
      });
      console.warn(`[break-glass] password reset for ${staffId} — REMOVE the RESET_STAFF_PASSWORD env var now`);
    } else {
      console.warn(`[break-glass] RESET_STAFF_PASSWORD set but staff id "${staffId}" not found`);
    }
  } else {
    console.warn("[break-glass] RESET_STAFF_PASSWORD malformed — expected staffId:password (password ≥ 8 chars)");
  }
}

const app = await buildApp(handle.db);
// custom-domain → site map: buildApp loads it once; keep it fresh so a
// domain recorded on another instance (or straight in the DB) takes effect
setInterval(() => void refreshSiteDomains(handle.db).catch(() => {}), 60 * 1000).unref();
const port = Number(process.env.PORT ?? 8787);
// bind all interfaces in production (Render/Railway route external traffic);
// loopback-only in dev
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port, host });
console.log(`currencydesk-server on http://${host}:${port}`);

// live market rates: pull the provider at most once per RATES_SYNC_MINUTES
// (default 60 → 24/day), decided by the age of the newest snapshot in the
// database. Because the gate is in the DB, not process memory, restarts don't
// re-pull — a Render free-tier instance that sleeps and cold-starts all day
// still pulls ~24 times, not once per wake. RATES_SYNC=off disables it.
if (process.env.RATES_SYNC !== "off") {
  const minutes = Math.max(1, Number(process.env.RATES_SYNC_MINUTES ?? 60));
  const gapMs = minutes * 60 * 1000;
  // a small grace so the on-the-hour check reliably clears the gate instead of
  // just missing it and waiting a whole extra cycle
  const gateMs = Math.max(gapMs - 60 * 1000, gapMs * 0.5);
  // check often enough to pull promptly after a cold start, but the DB gate
  // caps actual provider calls at one per gap regardless of check frequency
  const checkMs = Math.min(gapMs, 15 * 60 * 1000);
  const run = async () => {
    const r = await syncMarketRatesIfStale(handle.db, DEMO.branchId, gateMs);
    console.log(`[rates-sync] ${r.skipped ? "skip" : r.ok ? "ok" : "FAILED"} — ${r.detail}`);
  };
  void run();
  setInterval(run, checkMs).unref();
}
