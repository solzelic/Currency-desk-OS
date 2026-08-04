/* ============================================================
   FIFO, and the owner's right to choose it.

   The desk has always costed inventory by weighted average. Both methods
   are legitimate; they report different profit on identical trades, and
   which one gets used is a business decision an owner makes — not
   something their country decides for them.

   The trades below are the ones from the setting's own explainer, so what
   the owner is told in the app and what the book does are the same thing:

     Monday     buy  2,000 USD at 1.34   →  2,680 paid
     Wednesday  buy  2,000 USD at 1.42   →  2,840 paid
     Friday     sell 1,000 USD at 1.45   →  1,450 received

   Weighted average costs the sale at 1.38 and reports 70 earned.
   FIFO costs it against Monday's cash at 1.34 and reports 110. Neither is
   wrong; they differ only in timing, and Wednesday's dearer dollars come
   back to bite the FIFO desk on a later sale.

   The rest is what could go wrong: a sale spanning several lots, a sale
   larger than the oldest one, a reversal putting the exact quantities back
   in the exact lots they came from, and a desk flipping the setting
   mid-life without the book losing track of what it holds.
   ============================================================ */
import pg from "pg";
import Decimal from "decimal.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { acquire, dispose, reverseEvent } from "../src/ledger/cost-basis.js";
import { readCostMethod } from "../src/ledger/cost-method.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;

const SCOPE = {
  tenantId: "tnt-fifo",
  legalEntityId: "le-fifo",
  branchId: "br-fifo",
  locationKind: "till" as const,
  locationId: "till-fifo",
};
const USD = { ...SCOPE, currency: "USD" };

const MONDAY = new Date("2026-08-03T10:00:00Z");
const WEDNESDAY = new Date("2026-08-05T10:00:00Z");
const FRIDAY = new Date("2026-08-07T10:00:00Z");

async function withClient<T>(run: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

/** Put the entity on the ledger so the costing method has somewhere to live. */
async function seedEntity() {
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
    [SCOPE.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'FIFO Desk','x','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1'`,
    [SCOPE.legalEntityId, SCOPE.tenantId],
  );
  await pool.query("UPDATE legal_entities SET cost_method=NULL WHERE id=$1", [
    SCOPE.legalEntityId,
  ]);
}

const useMethod = (method: "weighted_average" | "fifo" | null) =>
  pool.query("UPDATE legal_entities SET cost_method=$1 WHERE id=$2", [
    method,
    SCOPE.legalEntityId,
  ]);

/* The drawer's quantity is the caller's business — the engine is told what
   was there before a movement and never moves cash itself. */
async function setQuantity(amount: string) {
  await pool.query(
    `INSERT INTO ledger_till_balances
       (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
     VALUES ($1,$2,$3,'ws-fifo',$4,'USD',$5)
     ON CONFLICT (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency)
     DO UPDATE SET available_amount=EXCLUDED.available_amount`,
    [SCOPE.tenantId, SCOPE.legalEntityId, SCOPE.branchId, SCOPE.locationId, amount],
  );
}

const avgOf = async () =>
  (
    await pool.query(
      "SELECT avg_cost FROM ledger_till_balances WHERE till_id=$1 AND currency='USD'",
      [SCOPE.locationId],
    )
  ).rows[0]?.avg_cost ?? null;

const lots = async () =>
  (
    await pool.query(
      `SELECT quantity, unit_cost_home, remaining_quantity, acquired_at
         FROM ledger_cost_lots WHERE location_id=$1 AND currency='USD'
        ORDER BY acquired_at, lot_id`,
      [SCOPE.locationId],
    )
  ).rows;

const consumptionOf = async (eventId: string) =>
  (
    await pool.query(
      `SELECT c.quantity, c.unit_cost_home, c.cost_home, c.reversed_by_event_id
         FROM ledger_cost_lot_consumption c
        WHERE c.event_id=$1
        ORDER BY c.unit_cost_home`,
      [eventId],
    )
  ).rows;

/** Monday's 2,000 at 1.34, then Wednesday's 2,000 at 1.42. */
async function buyTheWeek() {
  await withClient(async (client) => {
    await setQuantity("2000.00");
    await acquire(client, USD, {
      quantity: "2000.00",
      unitCostHome: "1.34",
      quantityBefore: new Decimal(0),
      avgCostBefore: null,
      eventKind: "purchase",
      sourceKind: "test",
      actorId: "tester",
      now: MONDAY,
    });
    await setQuantity("4000.00");
    await acquire(client, USD, {
      quantity: "2000.00",
      unitCostHome: "1.42",
      quantityBefore: new Decimal(2000),
      avgCostBefore: new Decimal("1.34"),
      eventKind: "purchase",
      sourceKind: "test",
      actorId: "tester",
      now: WEDNESDAY,
    });
  });
}

/** Friday's sale: `quantity` units for `proceeds` in home currency. */
const sell = (
  quantity: string,
  quantityBefore: string,
  avgCostBefore: string,
  proceeds: string,
  when = FRIDAY,
) =>
  withClient((client) =>
    dispose(client, USD, {
      quantity,
      quantityBefore: new Decimal(quantityBefore),
      avgCostBefore: new Decimal(avgCostBefore),
      proceedsHome: proceeds,
      eventKind: "sale",
      sourceKind: "test",
      actorId: "tester",
      now: when,
    }),
  );

postgres("FIFO as the desk's own choice", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.query(
      "TRUNCATE ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events CASCADE",
    );
    await pool.query("DELETE FROM ledger_till_balances WHERE till_id=$1", [
      SCOPE.locationId,
    ]);
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events CASCADE",
    );
    await pool.query("DELETE FROM ledger_till_balances WHERE till_id=$1", [
      SCOPE.locationId,
    ]);
    await seedEntity();
  });

  it("costs the same week's trading at 70 under weighted average", async () => {
    await useMethod("weighted_average");
    await buyTheWeek();
    await setQuantity("3000.00");
    // the drawer averages (2,680 + 2,840) ÷ 4,000 = 1.38 a dollar
    expect(new Decimal(await avgOf()).toFixed(2)).toBe("1.38");

    const sale = await sell("1000.00", "4000.00", "1.38", "1450.00");
    expect(sale.costOfSale.toFixed(2)).toBe("1380.00");
    expect(sale.realized!.toFixed(2)).toBe("70.00");
    // selling does not move a weighted average — only buying does
    expect(new Decimal(await avgOf()).toFixed(2)).toBe("1.38");
  });

  it("costs the identical trades at 110 under FIFO", async () => {
    await useMethod("fifo");
    await buyTheWeek();
    await setQuantity("3000.00");

    /* Same purchases, same sale, same proceeds. What differs is only which
       dollars the desk says it sold: FIFO says Monday's, at 1.34. */
    const sale = await sell("1000.00", "4000.00", "1.38", "1450.00");
    expect(sale.costOfSale.toFixed(2)).toBe("1340.00");
    expect(sale.realized!.toFixed(2)).toBe("110.00");

    // and it came out of Monday's lot, which anybody can read line by line
    const drawn = await consumptionOf(sale.eventId);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].quantity).toBe("1000.00");
    expect(new Decimal(drawn[0].unit_cost_home).toFixed(2)).toBe("1.34");
    expect(drawn[0].cost_home).toBe("1340.00");

    /* The 40 difference is timing, not money invented: what is left is
       dearer than it was, and the running average says so. 1,000 left at
       1.34 and 2,000 at 1.42 → 1.3933… */
    expect(new Decimal(await avgOf()).toFixed(4)).toBe("1.3933");
    const open = await lots();
    expect(open.map((row) => row.remaining_quantity)).toEqual([
      "1000.00",
      "2000.00",
    ]);
  });

  it("walks straight through the oldest lot into the next one", async () => {
    await useMethod("fifo");
    await buyTheWeek();
    await setQuantity("1000.00");

    // 3,000 sold: all of Monday's 2,000 at 1.34, then 1,000 of Wednesday's
    // at 1.42 — 2,680 + 1,420 = 4,100
    const sale = await sell("3000.00", "4000.00", "1.38", "4400.00");
    expect(sale.costOfSale.toFixed(2)).toBe("4100.00");
    expect(sale.realized!.toFixed(2)).toBe("300.00");

    const drawn = await consumptionOf(sale.eventId);
    expect(drawn.map((row) => [row.quantity, row.cost_home])).toEqual([
      ["2000.00", "2680.00"],
      ["1000.00", "1420.00"],
    ]);
    // Monday's lot is exhausted; Wednesday's is half gone
    expect((await lots()).map((row) => row.remaining_quantity)).toEqual([
      "0.00",
      "1000.00",
    ]);
    // only Wednesday's dollars are left, so that is what the drawer averages
    expect(new Decimal(await avgOf()).toFixed(2)).toBe("1.42");
  });

  it("spans three lots when one sale is bigger than any of them", async () => {
    await useMethod("fifo");
    await buyTheWeek();
    await withClient(async (client) => {
      await setQuantity("5000.00");
      await acquire(client, USD, {
        quantity: "1000.00",
        unitCostHome: "1.50",
        quantityBefore: new Decimal(4000),
        avgCostBefore: new Decimal("1.38"),
        eventKind: "purchase",
        sourceKind: "test",
        actorId: "tester",
        now: new Date("2026-08-06T10:00:00Z"),
      });
    });
    await setQuantity("500.00");

    // 4,500 out of 5,000: 2,000 at 1.34 + 2,000 at 1.42 + 500 at 1.50
    const sale = await sell("4500.00", "5000.00", "1.396", "6500.00");
    expect(sale.costOfSale.toFixed(2)).toBe("6270.00");
    expect(sale.realized!.toFixed(2)).toBe("230.00");
    expect(await consumptionOf(sale.eventId)).toHaveLength(3);
    expect((await lots()).map((row) => row.remaining_quantity)).toEqual([
      "0.00",
      "0.00",
      "500.00",
    ]);
  });

  it("puts the exact quantities back in the exact lots when a sale is reversed", async () => {
    await useMethod("fifo");
    await buyTheWeek();
    await setQuantity("1000.00");
    const sale = await sell("3000.00", "4000.00", "1.38", "4400.00");
    expect(sale.realized!.toFixed(2)).toBe("300.00");

    /* The desk keeps trading after the sale, so today's average has nothing
       to do with the lots the reversal has to restore. This is the case a
       reversal that "puts units back at the current average" gets wrong. */
    await withClient(async (client) => {
      await setQuantity("3000.00");
      await acquire(client, USD, {
        quantity: "2000.00",
        unitCostHome: "1.60",
        quantityBefore: new Decimal(1000),
        avgCostBefore: new Decimal("1.42"),
        eventKind: "purchase",
        sourceKind: "test",
        actorId: "tester",
        now: new Date("2026-08-08T10:00:00Z"),
      });
    });

    const undone = await withClient(async (client) => {
      await setQuantity("6000.00");
      return reverseEvent(client, sale.eventId, {
        sourceKind: "test",
        actorId: "tester",
        now: new Date("2026-08-09T10:00:00Z"),
      });
    });
    expect(undone!.realizedUnwound!.toFixed(2)).toBe("-300.00");

    /* Monday's lot is whole again, Wednesday's is whole again, and the
       purchase in between is untouched — not a redistribution that happens
       to add up. */
    expect(
      (await lots()).map((row) => [row.unit_cost_home, row.remaining_quantity]),
    ).toEqual([
      ["1.340000000000", "2000.00"],
      ["1.420000000000", "2000.00"],
      ["1.600000000000", "2000.00"],
    ]);
    // (2,680 + 2,840 + 3,200) ÷ 6,000 = 1.4533…
    expect(new Decimal(await avgOf()).toFixed(4)).toBe("1.4533");

    // and the consumption rows say which reversal put them back, so a second
    // reversal of the same sale cannot restore them twice
    const drawn = await consumptionOf(sale.eventId);
    expect(drawn.every((row) => row.reversed_by_event_id === undone!.eventId)).toBe(true);
    await withClient((client) =>
      reverseEvent(client, sale.eventId, {
        sourceKind: "test",
        actorId: "tester",
        now: new Date("2026-08-09T11:00:00Z"),
      }),
    );
    expect((await lots()).map((row) => row.remaining_quantity)).toEqual([
      "2000.00",
      "2000.00",
      "2000.00",
    ]);
  });

  it("takes a reversed purchase back out of its own lot", async () => {
    await useMethod("fifo");
    const bought = await withClient(async (client) => {
      await setQuantity("2000.00");
      await acquire(client, USD, {
        quantity: "2000.00",
        unitCostHome: "1.34",
        quantityBefore: new Decimal(0),
        avgCostBefore: null,
        eventKind: "purchase",
        sourceKind: "test",
        actorId: "tester",
        now: MONDAY,
      });
      await setQuantity("4000.00");
      return acquire(client, USD, {
        quantity: "2000.00",
        unitCostHome: "1.42",
        quantityBefore: new Decimal(2000),
        avgCostBefore: new Decimal("1.34"),
        eventKind: "purchase",
        sourceKind: "test",
        actorId: "tester",
        now: WEDNESDAY,
      });
    });

    await withClient(async (client) => {
      await setQuantity("2000.00");
      return reverseEvent(client, bought.eventId, {
        sourceKind: "test",
        actorId: "tester",
        now: FRIDAY,
      });
    });

    /* Wednesday's lot is emptied and MONDAY'S IS UNTOUCHED. Undoing a
       purchase against the front of the FIFO queue would take back cash the
       desk really has and leave behind cash it does not. */
    expect(
      (await lots()).map((row) => [row.unit_cost_home, row.remaining_quantity]),
    ).toEqual([
      ["1.340000000000", "2000.00"],
      ["1.420000000000", "0.00"],
    ]);
    expect(new Decimal(await avgOf()).toFixed(2)).toBe("1.34");
  });

  it("keeps the lots under weighted average too, so the switch has a history", async () => {
    await useMethod("weighted_average");
    await buyTheWeek();
    await setQuantity("3000.00");
    const sale = await sell("1000.00", "4000.00", "1.38", "1450.00");
    expect(sale.realized!.toFixed(2)).toBe("70.00");

    /* The sale was priced at the average, but the units still came out of
       Monday's lot and the book says which. Without this a desk turning FIFO
       on tomorrow would be pricing against acquisitions it had already
       sold. */
    expect((await lots()).map((row) => row.remaining_quantity)).toEqual([
      "1000.00",
      "2000.00",
    ]);
    expect(await consumptionOf(sale.eventId)).toHaveLength(1);
  });

  it("switches method mid-life without restating anything or losing the position", async () => {
    await useMethod("weighted_average");
    await buyTheWeek();
    await setQuantity("3000.00");
    const underAverage = await sell("1000.00", "4000.00", "1.38", "1450.00");
    expect(underAverage.realized!.toFixed(2)).toBe("70.00");

    await useMethod("fifo");
    await setQuantity("2000.00");
    /* 1,000 of Monday's dollars are left — the first sale took the other
       1,000 even though it was not priced against them — so this one costs
       1,000 × 1.34 and not 1,000 × 1.42. */
    const underFifo = await sell("1000.00", "3000.00", "1.38", "1450.00");
    expect(underFifo.costOfSale.toFixed(2)).toBe("1340.00");
    expect(underFifo.realized!.toFixed(2)).toBe("110.00");

    // the first sale is not restated: what was reported stays reported
    const events = await pool.query(
      `SELECT realized_pnl_home, cost_method FROM ledger_cost_events
        WHERE event_kind='sale' AND location_id=$1 ORDER BY created_at`,
      [SCOPE.locationId],
    );
    expect(events.rows.map((row) => row.realized_pnl_home)).toEqual([
      "70.00",
      "110.00",
    ]);
    // and each sale says which method priced it
    expect(events.rows.map((row) => row.cost_method)).toEqual([
      "weighted_average",
      "fifo",
    ]);
    // Wednesday's 2,000 are all that is left, and they are all that is left
    expect((await lots()).map((row) => row.remaining_quantity)).toEqual([
      "0.00",
      "2000.00",
    ]);
  });

  it("gives stock that has no lots behind it a basis rather than free dollars", async () => {
    await useMethod("fifo");
    /* A drawer holding cash whose acquisitions were never recorded as lots:
       the state every desk trading before this feature existed was in.
       Migration 014 reconstructs those, but cash can also reach a box
       through a path with no cost to carry, and a FIFO sale must not treat
       it as costing nothing. */
    await setQuantity("2000.00");
    await pool.query(
      "UPDATE ledger_till_balances SET avg_cost='1.380000000000' WHERE till_id=$1 AND currency='USD'",
      [SCOPE.locationId],
    );
    expect(await lots()).toHaveLength(0);

    await setQuantity("1000.00");
    const sale = await sell("1000.00", "2000.00", "1.38", "1450.00");
    expect(sale.costOfSale.toFixed(2)).toBe("1380.00");
    expect(sale.realized!.toFixed(2)).toBe("70.00");
    expect((await lots()).map((row) => row.remaining_quantity)).toEqual([
      "1000.00",
    ]);
  });

  it("follows the pack until the desk says otherwise, and the desk always wins", async () => {
    const following = await withClient((client) =>
      readCostMethod(client, SCOPE.legalEntityId),
    );
    expect(following).toEqual({
      method: "weighted_average",
      entityChoice: null,
      packDefault: "weighted_average",
    });

    /* A pack suggesting FIFO moves a desk that has not decided for itself
       — and cannot move one that has. That is the whole point of the
       override: an owner in any jurisdiction can run either method. */
    await pool.query(
      "UPDATE jurisdiction_packs SET default_cost_method='fifo' WHERE pack_id='pack-ca-v1'",
    );
    try {
      const suggested = await withClient((client) =>
        readCostMethod(client, SCOPE.legalEntityId),
      );
      expect(suggested.method).toBe("fifo");

      await useMethod("weighted_average");
      const overridden = await withClient((client) =>
        readCostMethod(client, SCOPE.legalEntityId),
      );
      expect(overridden).toEqual({
        method: "weighted_average",
        entityChoice: "weighted_average",
        packDefault: "fifo",
      });
    } finally {
      await pool.query(
        "UPDATE jurisdiction_packs SET default_cost_method='weighted_average' WHERE pack_id='pack-ca-v1'",
      );
    }
  });
});

/* ------------------------------------------------------------
   The setting over HTTP: who may change it, and what it leaves behind.
   ------------------------------------------------------------ */

async function cookieFor(staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

postgres("changing the costing method through the desk", () => {
  const scope = [
    DEMO.tenantId,
    DEMO.legalEntityId,
    DEMO.branchId,
    DEMO.workspaceId,
    "till-01",
  ];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await pool.query(
      "TRUNCATE ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,ledger_audit_events,ledger_principals CASCADE",
    );
    await pool.query("UPDATE legal_entities SET cost_method=NULL");
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,ledger_audit_events,ledger_principals CASCADE",
    );
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
      [DEMO.tenantId],
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'York FX Canada','FINTRAC','CAD','pack-ca-v1',1)
       ON CONFLICT (id) DO NOTHING`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    await pool.query("UPDATE legal_entities SET cost_method=NULL WHERE id=$1", [
      DEMO.legalEntityId,
    ]);
    await pool.query(
      `INSERT INTO ledger_principals
        (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
       VALUES
        ($1||':a.singh',$1,$2,$3,$4,$5,'teller','["br-yorkville"]'),
        ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]')`,
      scope,
    );
    for (const [staffId, role] of [
      ["a.singh", "teller"],
      ["r.haddad", "branch_manager"],
    ] as const) {
      await handle.db
        .update(schema.staffUsers)
        .set({ role, authorizedBranchIds: [DEMO.branchId] })
        .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:${staffId}`));
    }
  });

  it("reports what the desk costs by, and where the answer came from", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/ledger/cost-method",
      cookies: await cookieFor("a.singh"),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      method: "weighted_average",
      entityChoice: null,
      packDefault: "weighted_average",
    });
  });

  it("lets a manager turn FIFO on, and writes down who did it", async () => {
    const changed = await app.inject({
      method: "PUT",
      url: "/api/ledger/cost-method",
      payload: { method: "fifo" },
      cookies: await cookieFor("r.haddad"),
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({
      method: "fifo",
      entityChoice: "fifo",
      packDefault: "weighted_average",
    });

    /* It changes what the book reports as profit, so who flipped it and
       when is not optional — and the row says what it moved FROM, which is
       the half somebody actually needs a year later. */
    const audit = await pool.query(
      "SELECT actor_id, target_id, reason FROM ledger_audit_events WHERE action='cost_method.change'",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(`${DEMO.tenantId}:r.haddad`);
    expect(audit.rows[0].target_id).toBe(DEMO.legalEntityId);
    expect(audit.rows[0].reason).toBe(
      "pack_default (weighted_average) → fifo (fifo)",
    );
  });

  it("hands the decision back to the pack when asked", async () => {
    const cookies = await cookieFor("r.haddad");
    await app.inject({
      method: "PUT",
      url: "/api/ledger/cost-method",
      payload: { method: "fifo" },
      cookies,
    });
    const released = await app.inject({
      method: "PUT",
      url: "/api/ledger/cost-method",
      payload: { method: "pack_default" },
      cookies,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().entityChoice).toBeNull();
    expect(released.json().method).toBe("weighted_average");
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM ledger_audit_events WHERE action='cost_method.change'",
        )
      ).rows[0].count,
    ).toBe("2");
  });

  it("refuses a teller, and changes nothing", async () => {
    const denied = await app.inject({
      method: "PUT",
      url: "/api/ledger/cost-method",
      payload: { method: "fifo" },
      cookies: await cookieFor("a.singh"),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("AUTHORIZATION_DENIED");

    const still = await pool.query(
      "SELECT cost_method FROM legal_entities WHERE id=$1",
      [DEMO.legalEntityId],
    );
    expect(still.rows[0].cost_method).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM ledger_audit_events WHERE action='cost_method.change'",
        )
      ).rows[0].count,
    ).toBe("0");
  });

  it("refuses a method nobody supports", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/ledger/cost-method",
      payload: { method: "lifo" },
      cookies: await cookieFor("r.haddad"),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("will not answer at all without a session", async () => {
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/ledger/cost-method",
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
