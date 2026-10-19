/* York FX is seeded on every boot. A custom schedule must survive that
   byte for byte, and a boot that fills a missing schedule audits once. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

const custom = '[{"id":"payroll","label":"Payroll","feePct":0,"feeMin":0,"holdDays":1,"risk":"low"}]';
const expected = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE);

let handle: DbHandle;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
});
afterAll(async () => {
  await handle.close();
});

const york = () =>
  handle.db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId)).limit(1).then((rows) => rows[0]);

const fills = () =>
  handle.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.tenantId, DEMO.tenantId),
    eq(schema.auditEvents.action, "cheque.schedule_backfill"),
  ));

async function resetYork() {
  await handle.db.delete(schema.auditEvents).where(eq(schema.auditEvents.tenantId, DEMO.tenantId));
  await handle.db.delete(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
}

describe("York FX boot", () => {
  it("leaves a custom schedule byte for byte and does not audit again", async () => {
    await resetYork();
    await seed(handle.db);
    const first = await fills();
    expect(first).toHaveLength(1);
    expect(first[0]?.actorId).toBe("system seed");
    expect(first[0]?.detail.before).toBeNull();
    expect(first[0]?.detail.after).toBe(expected);

    await handle.db.update(schema.tenantState).set({
      state: { cdos_cheque_schedule_v1: custom, cdos_settings: "{\"bizName\":\"York FX\"}" },
      version: 4,
    }).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
    const before = (await york())!;

    await seed(handle.db);
    const after = (await york())!;
    expect(after.state).toEqual(before.state);
    expect(after.version).toBe(before.version);
    expect(after.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
    expect((await fills())).toHaveLength(1);
  });

  it("audits a boot that fills a missing schedule, and not the boot after", async () => {
    await resetYork();
    await seed(handle.db);
    await handle.db.update(schema.tenantState).set({
      state: { cdos_cheque_schedule_v1: "" },
      version: 2,
    }).where(eq(schema.tenantState.tenantId, DEMO.tenantId));

    await seed(handle.db);
    const filled = (await york())!;
    expect(filled.state.cdos_cheque_schedule_v1).toBe(expected);
    expect(filled.version).toBe(3);
    const rows = await fills();
    expect(rows).toHaveLength(2);
    const wrote = rows.find((row) => row.detail.before === "");
    expect(wrote?.actorId).toBe("system seed");
    expect(wrote?.detail.after).toBe(expected);

    await seed(handle.db);
    expect((await york())!.state.cdos_cheque_schedule_v1).toBe(expected);
    expect((await fills())).toHaveLength(2);
  });
});
