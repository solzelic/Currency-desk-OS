import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
const body = {
  customerId: "customer-demo",
  from: "CAD",
  to: "USD",
  inputAmount: "1000.00",
  feeCad: "4.00",
  direction: "customer_buy_foreign",
};
async function cookie(staffId = "m.costa") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value,
  };
}
async function reset() {
  await pool.query(
    "TRUNCATE quote_events,quote_overrides,quotes,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE",
  );
  const s = [
    DEMO.tenantId,
    DEMO.legalEntityId,
    DEMO.branchId,
    DEMO.workspaceId,
    "till-01",
  ];
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [s[0]],
  );
  await pool.query(
    "INSERT INTO legal_entities (id,tenant_id,name) VALUES ($1,$2,'York FX Canada') ON CONFLICT DO NOTHING",
    [s[1], s[0]],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
    [s[2], s[0], s[1]],
  );
  await pool.query(
    "INSERT INTO ledger_principals VALUES ($1||':m.costa',$1,$2,$3,$4,$5,'teller','[\"br-yorkville\"]'),($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','[\"br-yorkville\"]')",
    s,
  );
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified')",
    s.slice(0, 4),
  );
  for (const [c, v] of [
    ["CAD", 25000],
    ["USD", 12000],
  ])
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...s, c, v],
    );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('snap-1','test','{\"USD\":1.4}',now())",
  );
  await pool.query(
    'INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at) VALUES (\'board-1\',$1,$2,$3,0.02,0.03,\'{"USD":{"mid":1.4,"show":true}}\',\'snap-1\',now())',
    s.slice(0, 3),
  );
}
postgres("quote service against real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });
  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });
  beforeEach(reset);
  it("creates a customer-buy quote using We Sell with board and snapshot lineage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: await cookie(),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const q = res.json();
    expect(q.buyOrSellSide).toBe("we_sell");
    expect(q.rateBoardPublicationId).toBe("board-1");
    expect(q.marketSnapshotId).toBe("snap-1");
    expect(q.customerRate).toBe("0.692857142857");
    expect(q.outputAmount).toBe("692.86");
  });
  it("creates a customer-sell quote using We Buy and preserves old board terms", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: await cookie(),
      payload: {
        ...body,
        from: "USD",
        to: "CAD",
        direction: "customer_sell_foreign",
      },
    });
    const q = created.json();
    expect(q.buyOrSellSide).toBe("we_buy");
    expect(q.customerRate).toBe("1.372000000000");
    await pool.query(
      'INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,published_at) VALUES (\'board-2\',$1,$2,$3,0.1,0.1,\'{"USD":{"mid":2.0,"show":true}}\',now())',
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
    );
    const old = await app.inject({
      method: "GET",
      url: `/api/quotes/${q.quoteId}`,
      cookies: await cookie(),
    });
    expect(old.json().customerRate).toBe("1.372000000000");
  });
  it("rejects stale, expired, cancelled, malformed, and wrong-workspace quote requests", async () => {
    await pool.query(
      "UPDATE rate_boards SET published_at=now()-interval '1 hour'",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/quotes",
          cookies: await cookie(),
          payload: body,
        })
      ).statusCode,
    ).toBe(422);
    await reset();
    const made = (
      await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: body,
      })
    ).json();
    await pool.query(
      "UPDATE quotes SET expires_at=now()-interval '1 second' WHERE quote_id=$1",
      [made.quoteId],
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/quotes/${made.quoteId}/post`,
          cookies: await cookie(),
          payload: { idempotencyKey: "expired", purpose: "Personal travel", sourceOfFunds: "Employment income" },
        })
      ).statusCode,
    ).toBe(422);
    const cancelled = (
      await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: { ...body, inputAmount: "999.00" },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/quotes/${cancelled.quoteId}/cancel`,
          cookies: await cookie(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/quotes/${cancelled.quoteId}/post`,
          cookies: await cookie(),
          payload: { idempotencyKey: "cancelled", purpose: "Personal travel", sourceOfFunds: "Employment income" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/quotes",
          cookies: await cookie(),
          payload: { ...body, inputAmount: "1e3" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/quotes",
          cookies: await cookie(),
          headers: { "x-workspace-id": "wrong" },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("requires override authority and preserves original terms", async () => {
    const made = (
      await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: body,
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/quotes/${made.quoteId}/override`,
          cookies: await cookie(),
          payload: { customerRate: "0.69", reason: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/quotes/${made.quoteId}/override`,
          cookies: await cookie(),
          payload: { customerRate: "0.69", reason: "Manager approved" },
        })
      ).statusCode,
    ).toBe(403);
    const manager = await cookie("r.haddad");
    const over = await app.inject({
      method: "POST",
      url: `/api/quotes/${made.quoteId}/override`,
      cookies: manager,
      payload: { customerRate: "0.69", reason: "Manager approved" },
    });
    expect(over.statusCode).toBe(200);
    expect(over.json().override.customerRate).toBe("0.690000000000");
    expect(
      (
        await pool.query("SELECT customer_rate FROM quotes WHERE quote_id=$1", [
          made.quoteId,
        ])
      ).rows[0].customer_rate,
    ).toBe(made.customerRate);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/quotes/${made.quoteId}/override`,
          cookies: manager,
          payload: { customerRate: "0.2", reason: "Too much" },
        })
      ).statusCode,
    ).toBe(422);
  });
  it("posts exactly one ledger transaction from frozen quote terms", async () => {
    const made = (
      await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: body,
      })
    ).json();
    const first = await app.inject({
      method: "POST",
      url: `/api/quotes/${made.quoteId}/post`,
      cookies: await cookie(),
      payload: { idempotencyKey: "quote-post", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/quotes/${made.quoteId}/post`,
      cookies: await cookie(),
      payload: { idempotencyKey: "quote-post", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.json().transactionId).toBe(first.json().transactionId);
    const tx = await pool.query(
      "SELECT output_amount,rate,fee_cad,spread_cad FROM ledger_transactions WHERE transaction_id=$1",
      [first.json().transactionId],
    );
    expect(tx.rowCount).toBe(1);
    expect(tx.rows[0]).toMatchObject({
      output_amount: made.outputAmount,
      rate: made.customerRate,
      fee_cad: made.feeCad,
      spread_cad: made.spreadCad,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM ledger_till_movements WHERE transaction_id=$1",
          [first.json().transactionId],
        )
      ).rows[0].count,
    ).toBe("3");
    expect(first.json().receipt.lines.join(" ")).toContain(made.outputAmount);
  });
  it("atomically deduplicates simultaneous quote posts", async () => {
    const made = (await app.inject({ method: "POST", url: "/api/quotes", cookies: await cookie(), payload: body })).json();
    const cookies = await cookie();
    const responses = await Promise.all(["same-key", "same-key"].map((idempotencyKey) => app.inject({ method: "POST", url: `/api/quotes/${made.quoteId}/post`, cookies, payload: { idempotencyKey, purpose: "Personal travel", sourceOfFunds: "Employment income" } })));
    expect([201, 409]).toContain(responses[0]!.statusCode);
    expect([201, 409]).toContain(responses[1]!.statusCode);
    expect((await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0].count).toBe("1");
    expect((await pool.query("SELECT count(*) FROM ledger_journal_entries")).rows[0].count).toBe("4");
    expect((await pool.query("SELECT count(*) FROM ledger_till_movements")).rows[0].count).toBe("3");
    expect((await pool.query("SELECT count(*) FROM ledger_audit_events")).rows[0].count).toBe("1");
    const quote = await pool.query("SELECT status,posted_transaction_id FROM quotes WHERE quote_id=$1", [made.quoteId]);
    expect(quote.rows[0]).toMatchObject({ status: "posted" });
    expect(quote.rows[0].posted_transaction_id).toBeTruthy();
  });
});
