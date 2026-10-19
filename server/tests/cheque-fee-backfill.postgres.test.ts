/* Migration 045 writes the default cheque schedule where none is stored.
   A null, an empty string, "[]", or text that is not a schedule is missing.
   A stored schedule, including 0%, stays byte for byte.
   Each desk that changes gets one audit row. A second run writes none.
   The runner skips an id it has already applied, so the SQL is run here. */
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const sql = readFileSync(new URL("../src/db/migrations/045_cheque_fee_schedule.sql", import.meta.url), "utf8");
const ids = ["tnt-fee-none", "tnt-fee-empty", "tnt-fee-kept", "tnt-fee-null", "tnt-fee-blank", "tnt-fee-brackets", "tnt-fee-bad"];
const kept = '[{"id":"payroll","label":"Payroll","feePct":0,"feeMin":0,"holdDays":1,"risk":"low"}]';
const expected = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE);

describe("cheque schedule migration registration", () => {
  it("registers 045 with the migration runner", () => {
    expect(migrations).toContainEqual(["045_cheque_fee_schedule", "src/db/migrations/045_cheque_fee_schedule.sql"]);
  });
});

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
      await pool.query("DELETE FROM audit_events WHERE tenant_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM tenant_state WHERE tenant_id = ANY($1)", [ids]);
      await pool.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
      await pool.end();
    }
    if (handle) await handle.close();
    delete process.env.DATABASE_URL;
  });

  it("fills every missing schedule, leaves a real one byte for byte, and audits once", async () => {
    await pool.query("DELETE FROM audit_events WHERE tenant_id = ANY($1)", [ids]);
    await pool.query("DELETE FROM tenant_state WHERE tenant_id = ANY($1)", [ids]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
    await pool.query(
      `INSERT INTO tenants (id, name) VALUES
        ('tnt-fee-none','None'),('tnt-fee-empty','Empty'),('tnt-fee-kept','Kept'),
        ('tnt-fee-null','Null'),('tnt-fee-blank','Blank'),('tnt-fee-brackets','Brackets'),('tnt-fee-bad','Bad')`,
    );
    await pool.query(
      `INSERT INTO tenant_state (tenant_id, state, version) VALUES
        ('tnt-fee-empty', '{}'::jsonb, 3),
        ('tnt-fee-kept', $1::jsonb, 4),
        ('tnt-fee-null', '{"cdos_cheque_schedule_v1":null}'::jsonb, 2),
        ('tnt-fee-blank', '{"cdos_cheque_schedule_v1":""}'::jsonb, 5),
        ('tnt-fee-brackets', '{"cdos_cheque_schedule_v1":"[]"}'::jsonb, 6),
        ('tnt-fee-bad', '{"cdos_cheque_schedule_v1":"not-json"}'::jsonb, 7)`,
      [JSON.stringify({ cdos_cheque_schedule_v1: kept })],
    );
    const keptBefore = (await pool.query("SELECT state::text AS state, version FROM tenant_state WHERE tenant_id='tnt-fee-kept'")).rows[0];

    await pool.query(sql);
    const read = async (id: string) =>
      (await pool.query("SELECT state->>'cdos_cheque_schedule_v1' AS schedule, version FROM tenant_state WHERE tenant_id=$1", [id])).rows[0];

    expect((await read("tnt-fee-none")).schedule).toBe(expected);
    expect(Number((await read("tnt-fee-none")).version)).toBe(0);
    expect((await read("tnt-fee-empty")).schedule).toBe(expected);
    expect(Number((await read("tnt-fee-empty")).version)).toBe(4);
    expect((await read("tnt-fee-null")).schedule).toBe(expected);
    expect((await read("tnt-fee-blank")).schedule).toBe(expected);
    expect((await read("tnt-fee-brackets")).schedule).toBe(expected);
    expect((await read("tnt-fee-bad")).schedule).toBe(expected);
    const keptAfter = (await pool.query("SELECT state::text AS state, version FROM tenant_state WHERE tenant_id='tnt-fee-kept'")).rows[0];
    expect(keptAfter.state).toBe(keptBefore.state);
    expect(Number(keptAfter.version)).toBe(Number(keptBefore.version));
    expect((await read("tnt-fee-kept")).schedule).toBe(kept);

    const audits = await pool.query(
      "SELECT tenant_id, actor_id, action, detail FROM audit_events WHERE tenant_id = ANY($1) ORDER BY tenant_id",
      [ids],
    );
    expect(audits.rowCount).toBe(6);
    const byId = Object.fromEntries(audits.rows.map((row) => [row.tenant_id, row]));
    for (const id of ["tnt-fee-none", "tnt-fee-empty", "tnt-fee-null", "tnt-fee-blank", "tnt-fee-brackets", "tnt-fee-bad"]) {
      expect(byId[id].actor_id).toBe("system migration");
      expect(byId[id].action).toBe("cheque.schedule_backfill");
      expect(byId[id].detail.after).toBe(expected);
    }
    expect(byId["tnt-fee-none"].detail.before).toBeNull();
    expect(byId["tnt-fee-empty"].detail.before).toBeNull();
    expect(byId["tnt-fee-null"].detail.before).toBeNull();
    expect(byId["tnt-fee-blank"].detail.before).toBe("");
    expect(byId["tnt-fee-brackets"].detail.before).toBe("[]");
    expect(byId["tnt-fee-bad"].detail.before).toBe("not-json");
    expect(byId["tnt-fee-kept"]).toBeUndefined();

    const marker = JSON.stringify(await Promise.all(ids.map((id) => read(id))));
    await pool.query(sql);
    expect(JSON.stringify(await Promise.all(ids.map((id) => read(id))))).toBe(marker);
    expect((await pool.query("SELECT actor_id FROM audit_events WHERE tenant_id = ANY($1)", [ids])).rowCount).toBe(6);
  });
});
