/* ============================================================
   What the cash cost, and what the desk made selling it.

   The book used to value both sides of an exchange at the market mid of
   the moment and credit the gap to the customer's rate as revenue — so it
   booked a gain the instant a trade happened, against a price nobody paid,
   and could not answer "did we make money on US dollars this week".

   These tests hold the replacement: a desk buys at one rate, sells at
   another, and the difference — not a spread against a reference price —
   is what it earned. Including when that difference is a loss.
   ============================================================ */
import pg from "pg";
import Decimal from "decimal.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  acquire,
  currentBasis,
  dispose,
  ensureBasis,
  reverseEvent,
} from "../src/ledger/cost-basis.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;

const SCOPE = {
  tenantId: "tnt-cost",
  legalEntityId: "le-cost",
  branchId: "br-cost",
  locationKind: "till" as const,
  locationId: "till-cost",
};
const USD = { ...SCOPE, currency: "USD" };
const now = new Date("2026-08-04T12:00:00Z");

async function withClient<T>(run: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

/** Put a known quantity in the drawer with no basis, as pre-tracking cash. */
async function seedQuantity(amount: string) {
  await pool.query(
    `INSERT INTO ledger_till_balances
       (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
     VALUES ($1,$2,$3,'ws-cost',$4,'USD',$5)`,
    [SCOPE.tenantId, SCOPE.legalEntityId, SCOPE.branchId, SCOPE.locationId, amount],
  );
}

async function setQuantity(amount: string) {
  await pool.query(
    "UPDATE ledger_till_balances SET available_amount=$1 WHERE till_id=$2 AND currency='USD'",
    [amount, SCOPE.locationId],
  );
}

const avgOf = async () =>
  (await pool.query(
    "SELECT avg_cost FROM ledger_till_balances WHERE till_id=$1 AND currency='USD'",
    [SCOPE.locationId],
  )).rows[0].avg_cost;

postgres("cost basis against real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE ledger_cost_events CASCADE");
    await pool.query("DELETE FROM ledger_till_balances WHERE till_id=$1", [SCOPE.locationId]);
  });

  it("weights the average toward what was actually paid", async () => {
    await seedQuantity("0.00");
    await withClient(async (client) => {
      // bought 1,000 USD for 1,400 CAD → 1.40 a unit
      await setQuantity("1000.00");
      await acquire(client, USD, {
        quantity: "1000.00", unitCostHome: "1.40",
        quantityBefore: new Decimal(0), avgCostBefore: null,
        eventKind: "purchase", sourceKind: "test", actorId: "tester", now,
      });
      expect(new Decimal(await avgOf()).toFixed(4)).toBe("1.4000");

      // then 1,000 more for 1,500 CAD → 1.50 a unit. The average is the
      // blend, not the latest price.
      await setQuantity("2000.00");
      await acquire(client, USD, {
        quantity: "1000.00", unitCostHome: "1.50",
        quantityBefore: new Decimal(1000), avgCostBefore: new Decimal("1.40"),
        eventKind: "purchase", sourceKind: "test", actorId: "tester", now,
      });
      expect(new Decimal(await avgOf()).toFixed(4)).toBe("1.4500");
    });
  });

  it("realizes the difference between what it sold for and what it cost", async () => {
    await seedQuantity("2000.00");
    await pool.query(
      "UPDATE ledger_till_balances SET avg_cost='1.450000000000' WHERE till_id=$1 AND currency='USD'",
      [SCOPE.locationId],
    );
    const result = await withClient(async (client) => {
      await setQuantity("1000.00");
      // sold 1,000 USD for 1,520 CAD, having paid 1.45 a unit
      return dispose(client, USD, {
        quantity: "1000.00",
        quantityBefore: new Decimal(2000),
        avgCostBefore: new Decimal("1.45"),
        proceedsHome: "1520.00",
        eventKind: "sale", sourceKind: "test", actorId: "tester", now,
      });
    });
    expect(result.costOfSale.toFixed(2)).toBe("1450.00");
    expect(result.realized!.toFixed(2)).toBe("70.00");
    // selling does not move the average — only buying does
    expect(new Decimal(await avgOf()).toFixed(4)).toBe("1.4500");
  });

  it("records a loss as a loss", async () => {
    await seedQuantity("1000.00");
    const result = await withClient(async (client) => {
      await setQuantity("500.00");
      // paid 1.50, sold at 1.42 — the desk lost money and the book says so
      return dispose(client, USD, {
        quantity: "500.00",
        quantityBefore: new Decimal(1000),
        avgCostBefore: new Decimal("1.50"),
        proceedsHome: "710.00",
        eventKind: "sale", sourceKind: "test", actorId: "tester", now,
      });
    });
    expect(result.costOfSale.toFixed(2)).toBe("750.00");
    expect(result.realized!.toFixed(2)).toBe("-40.00");
  });

  it("refuses to sell out of a basis it does not know", async () => {
    await seedQuantity("1000.00");
    await expect(
      withClient((client) =>
        dispose(client, USD, {
          quantity: "100.00",
          quantityBefore: new Decimal(1000),
          avgCostBefore: null,          // pre-tracking cash
          proceedsHome: "142.00",
          eventKind: "sale", sourceKind: "test", actorId: "tester", now,
        }),
      ),
    ).rejects.toThrow(/cost basis missing/);
  });

  it("gives pre-tracking cash an opening basis, and says it was estimated", async () => {
    await seedQuantity("1000.00");
    await withClient(async (client) => {
      const basis = await currentBasis(client, USD);
      expect(basis.avgCost).toBeNull();

      const seeded = await ensureBasis(client, USD, {
        fallbackUnitCostHome: "1.38",
        quantity: basis.quantity,
        avgCost: basis.avgCost,
        actorId: "tester", now, sourceKind: "test",
      });
      expect(seeded!.toFixed(2)).toBe("1.38");
    });
    /* The point of the label: every basis still carrying an assumption can
       be found, rather than passing silently as something somebody paid. */
    const events = await pool.query(
      "SELECT event_kind FROM ledger_cost_events WHERE currency='USD'",
    );
    expect(events.rows.map((r) => r.event_kind)).toEqual(["opening_estimated"]);
  });

  it("clears the average when the drawer empties, so the next buy starts fresh", async () => {
    await seedQuantity("500.00");
    await withClient(async (client) => {
      await setQuantity("0.00");
      await dispose(client, USD, {
        quantity: "500.00",
        quantityBefore: new Decimal(500),
        avgCostBefore: new Decimal("1.50"),
        proceedsHome: "760.00",
        eventKind: "sale", sourceKind: "test", actorId: "tester", now,
      });
    });
    // blending the next purchase with the cost of cash that is gone would
    // be arithmetic on nothing
    expect(await avgOf()).toBeNull();
  });

  it("puts reversed units back at the cost they left at, not at today's", async () => {
    await seedQuantity("1000.00");
    const sale = await withClient(async (client) => {
      await setQuantity("500.00");
      return dispose(client, USD, {
        quantity: "500.00",
        quantityBefore: new Decimal(1000),
        avgCostBefore: new Decimal("1.40"),
        proceedsHome: "750.00",
        eventKind: "sale", sourceKind: "test", actorId: "tester", now,
      });
    });
    expect(sale.realized!.toFixed(2)).toBe("50.00");

    // the desk buys more, expensively, moving the average
    await withClient(async (client) => {
      await setQuantity("1500.00");
      await acquire(client, USD, {
        quantity: "1000.00", unitCostHome: "1.60",
        quantityBefore: new Decimal(500), avgCostBefore: new Decimal("1.40"),
        eventKind: "purchase", sourceKind: "test", actorId: "tester", now,
      });
    });

    // now reverse the sale. The 500 units come back at 1.40 — what they left
    // at — not at the 1.53 the drawer now averages.
    const undone = await withClient(async (client) => {
      await setQuantity("2000.00");
      return reverseEvent(client, sale.eventId, {
        sourceKind: "test", actorId: "tester", now,
      });
    });
    expect(undone!.realizedUnwound!.toFixed(2)).toBe("-50.00");

    const restored = new Decimal(await avgOf());
    // (1500 × 1.5333…) + (500 × 1.40), over 2000
    expect(restored.toFixed(4)).toBe("1.5000");
  });
});
