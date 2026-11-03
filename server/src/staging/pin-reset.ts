/* Staging test shops: every person's stored PIN is 0000 (#609 PR B).
   Three gates, read fresh every run: exactly one 'staging' row in
   db_environment, isStagingRuntime, and tenants.is_test_shop. A shop with a
   Persona key, a Persona inquiry, a live Stripe object, a filed report or a
   real FINTRAC number is never reset. Anything that throws: one error line,
   nothing changes (one transaction), boot goes on. 0000 is stored as the
   normal hash, so verify, switch and approvals need no special path. */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import type { Db } from "../db/index.js";
import { isStagingRuntime } from "../auth/staging-runtime.js";
import { verifyPassword } from "../auth/password.js";
import { hashPin } from "../routes/pin.js";
import { DEMO } from "../seed.js";

import { SEED_PLACEHOLDER_FINTRAC } from "./fintrac-placeholder.js";

export { fintracNumberFileable, SEED_PLACEHOLDER_FINTRAC } from "./fintrac-placeholder.js";
const STAGING_PIN = "0000";

type Q = Pick<pg.PoolClient, "query">;
type Log = { warn: (m: string) => void; error: (m: string) => void };
type Scope = { tenant_id: string; legal_entity_id: string; branch_id: string };

/** Exactly one row, and it says staging. No table, no row or more than one is live. */
export async function databaseIsStaging(q: Q): Promise<boolean> {
  if (!(await q.query("SELECT to_regclass('public.db_environment') IS NOT NULL AS ok")).rows[0]?.ok) return false;
  const rows = (await q.query("SELECT environment FROM db_environment")).rows;
  return rows.length === 1 && rows[0].environment === "staging";
}

/** All three gates for one request's shop: the switch accepts a stored 0000 only here. */
export async function stagingTestShop(db: Db, tenantId: string, host: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (!isStagingRuntime(host, env)) return false;
    if (!(await db.execute(sql`SELECT to_regclass('public.db_environment') IS NOT NULL AS ok`)).rows[0]?.ok) return false;
    const marker = (await db.execute(sql`SELECT environment FROM db_environment`)).rows;
    if (marker.length !== 1 || marker[0]?.environment !== "staging") return false;
    return (await db.execute(sql`SELECT is_test_shop FROM tenants WHERE id = ${tenantId}`)).rows[0]?.is_test_shop === true;
  } catch {
    return false;   // unreadable means closed
  }
}

/** Reasons a shop is never reset; empty when it may be. */
async function neverReset(q: Q, tenantId: string): Promise<string[]> {
  const checks: Array<[string, string, unknown[]]> = [
    ["fintrac", `SELECT 1 FROM legal_entities e JOIN tenants t ON t.id = e.tenant_id WHERE e.tenant_id = $1
       AND coalesce(e.msb_number, '') <> '' AND (e.msb_number <> $2 OR t.seeded_by IS DISTINCT FROM 'staging_seed')`, [tenantId, SEED_PLACEHOLDER_FINTRAC]],
    ["persona_key", "SELECT 1 FROM idv_shop_config c JOIN legal_entities e ON e.id = c.shop_id WHERE e.tenant_id = $1 AND (c.api_key_ref IS NOT NULL OR c.checks_enabled)", [tenantId]],
    ["persona_inquiry", "SELECT 1 FROM idv_inquiries i JOIN legal_entities e ON e.id = i.shop_id WHERE e.tenant_id = $1", [tenantId]],
    ["stripe_live", "SELECT 1 FROM stripe_events WHERE tenant_id = $1 AND livemode", [tenantId]],
    ["filed", "SELECT 1 FROM ledger_report_filings WHERE tenant_id = $1 AND status IN ('filed', 'amended')", [tenantId]],
  ];
  const why: string[] = [];
  for (const [reason, sql, args] of checks) if ((await q.query(sql, args)).rows.length) why.push(reason);
  return why;
}

async function audit(q: Q, at: Scope, action: string, detail: object): Promise<void> {
  await q.query(
    "INSERT INTO audit_events (id, tenant_id, legal_entity_id, branch_id, actor_id, action, detail) VALUES ($1, $2, $3, $4, 'system', $5, $6)",
    [randomUUID(), at.tenant_id, at.legal_entity_id, at.branch_id, action, JSON.stringify(detail)],
  );
}

/** The one PIN write that skips the weak-PIN rule, by name (pin-repeat-rule.test.ts). */
async function writeStagingResetPin(q: Q, userId: string): Promise<void> {
  await q.query("UPDATE staff_users SET pin_hash = $1, pin_set_at = now(), pin_must_change = false WHERE id = $2", [await hashPin(STAGING_PIN), userId]);
}

/** The seed's own shop becomes a test shop when nothing real is on it. */
async function markSeedShop(q: Q): Promise<boolean> {
  await q.query("UPDATE tenants SET seeded_by = 'staging_seed' WHERE id = $1 AND seeded_by IS NULL", [DEMO.tenantId]);
  const shop = (await q.query("SELECT is_test_shop, seeded_by FROM tenants WHERE id = $1", [DEMO.tenantId])).rows[0];
  if (!shop || shop.is_test_shop || shop.seeded_by !== "staging_seed" || (await neverReset(q, DEMO.tenantId)).length) return false;
  await q.query("UPDATE tenants SET is_test_shop = true WHERE id = $1", [DEMO.tenantId]);
  await audit(q, { tenant_id: DEMO.tenantId, legal_entity_id: DEMO.legalEntityId, branch_id: DEMO.branchId },
    "tenant.test_shop_changed", { reason: "staging_demo_seed", old: false, new: true });
  return true;
}

export async function runStagingPinReset(
  pool: Pick<pg.Pool, "connect">, env: NodeJS.ProcessEnv = process.env, log: Log = console,
): Promise<{ marked: boolean; reset: number }> {
  const none = { marked: false, reset: 0 };
  if (!isStagingRuntime(undefined, env)) return none;
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (!(await databaseIsStaging(client))) { await client.query("ROLLBACK"); return none; }
    const marked = await markSeedShop(client);
    let reset = 0;
    for (const { id } of (await client.query("SELECT id FROM tenants WHERE is_test_shop = true ORDER BY id")).rows) {
      if ((await neverReset(client, id)).length) continue;
      /* Everyone whose every staff row, under any shop, is in a test shop. */
      const people = (await client.query(
        `SELECT s.id, s.tenant_id, s.legal_entity_id, s.branch_id, s.pin_hash, s.pin_must_change FROM staff_users s
          WHERE s.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM staff_users o JOIN tenants t ON t.id = o.tenant_id
            WHERE lower(o.staff_id) = lower(s.staff_id) AND t.is_test_shop IS NOT TRUE)`, [id])).rows;
      let n = 0;
      for (const p of people) {
        if (p.pin_hash && !p.pin_must_change && await verifyPassword(STAGING_PIN, p.pin_hash)) continue;
        await writeStagingResetPin(client, p.id);
        await audit(client, p, "pin.staging_reset", { userId: p.id, reason: "staging_reset", at: new Date().toISOString() });
        n += 1;
      }
      log.warn(`[staging-pin-reset] ${id}: ${n} people set to the staging PIN`);
      reset += n;
    }
    await client.query("COMMIT");
    return { marked, reset };
  } catch (err) {
    /* The transaction is already failed; a ROLLBACK error adds nothing to report. */
    await client?.query("ROLLBACK").catch(() => undefined);
    const e = err as { name?: string; code?: string };
    log.error(`[staging-pin-reset] stopped, nothing changed (${e?.name ?? "Error"}${e?.code ? ` ${e.code}` : ""})`);
    return none;
  } finally {
    client?.release();
  }
}
