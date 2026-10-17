/* Migration 045 writes the default cheque schedule only where none is stored.
   A desk that already has one, including 0% or null, is unchanged.
   Running the file again changes nothing and writes no audit row.
   The runner skips an id it has already applied, so this test runs the SQL itself. */
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const sql = readFileSync(new URL("../src/db/migrations/045_cheque_fee_schedule.sql", import.meta.url), "utf8");
const ids = ["tnt-fee-none", "tnt-fee-empty", "tnt-fee-kept", "tnt-fee-null"];
const kept = JSON.stringify([{ id: "payroll", label: "Payroll", feePct: 0, feeMin: 0, holdDays: 1, risk: "low" }]);
const expected = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE);

postgres("cheque schedule backfill", () => {
  let pool: pg.Pool;
  let handle: DbHandle;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM tenant_state WHERE tenant_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
      await pool.end();
    }
    if (handle) await handle.close();
    delete process.env.DATABASE_URL;
  });

  it("writes the default only where none is stored, and a second run changes nothing", async () => {
    await pool.query("DELETE FROM tenant_state WHERE tenant_id = ANY($1)", [ids]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
    await pool.query("INSERT INTO tenants (id, name) VALUES ('tnt-fee-none','None'),('tnt-fee-empty','Empty'),('tnt-fee-kept','Kept'),('tnt-fee-null','Null')");
    await pool.query(
      "INSERT INTO tenant_state (tenant_id, state, version) VALUES ('tnt-fee-empty', '{}'::jsonb, 3), ('tnt-fee-kept', $1::jsonb, 4), ('tnt-fee-null', '{\"cdos_cheque_schedule_v1\":null}'::jsonb, 2)",
      [JSON.stringify({ cdos_cheque_schedule_v1: kept })],
    );

    await pool.query(sql);
    const read = async (id: string) =>
      (await pool.query("SELECT state->>'cdos_cheque_schedule_v1' AS schedule, version FROM tenant_state WHERE tenant_id=$1", [id])).rows[0];

    const none = await read("tnt-fee-none");
    const empty = await read("tnt-fee-empty");
    expect(none.schedule).toBe(expected);
    expect(Number(none.version)).toBe(0);
    expect(empty.schedule).toBe(expected);
    expect(Number(empty.version)).toBe(4);
    expect((await read("tnt-fee-kept")).schedule).toBe(kept);
    expect(Number((await read("tnt-fee-kept")).version)).toBe(4);
    expect((await read("tnt-fee-null")).schedule).toBe(null);
    expect(Number((await read("tnt-fee-null")).version)).toBe(2);

    const marker = JSON.stringify([none, empty, await read("tnt-fee-kept"), await read("tnt-fee-null")]);
    await pool.query(sql);
    expect(JSON.stringify([await read("tnt-fee-none"), await read("tnt-fee-empty"), await read("tnt-fee-kept"), await read("tnt-fee-null")])).toBe(marker);
    expect((await pool.query("SELECT actor_id FROM audit_events WHERE tenant_id = ANY($1)", [ids])).rowCount).toBe(0);
  });
});
