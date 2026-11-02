/* ============================================================
   A close that was counted, and then the drawer moved.

   Device A reads the book and counts it. Device B posts a deal.
   A then closes with the figures from the count. That close used
   to be accepted, and it wrote the old count back over the deal.
   The next open started from the count, and the deal was gone
   from the drawer.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;

/* Every count the till must refuse (#558): too many places, look-alike
   digits, every comma (none is read as a thousands mark), a European
   1.500,25, Arabic and full-width commas, a thin space, and a sign. */
const REFUSED_COUNTS = [
  "1.999", "1500²", "１５００", "١٥٠٠", "1500₂",
  "1,500", "1,500.25", "0,500", "00,500", "000,500", "1500,7", "1,50", ",500",
  "1.500,25", "1\u060C500", "1\uFF0C500", "1\u2009500", "+1500", "-1500",
];

const scope = [
  DEMO.tenantId,
  DEMO.legalEntityId,
  DEMO.branchId,
  DEMO.workspaceId,
  "till-01",
];

async function cookie(staffId = "a.singh") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

async function reset() {
  await pool.query(
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_till_balance_generations,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES
      ($1||':a.singh',$1,$2,$3,$4,$5,'teller','["br-yorkville"]'),
      ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]')`,
    scope,
  );
  await pool.query(
    `INSERT INTO ledger_customers
      (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
     VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','normal','verified')`,
    scope.slice(0, 4),
  );
  await pool.query(
    `INSERT INTO ledger_rates VALUES
      ($1,$2,$3,$4,'CAD',1),
      ($1,$2,$3,$4,'USD',0.731),
      ($1,$2,$3,$4,'EUR',0.676),
      ($1,$2,$3,$4,'GBP',0.581)`,
    scope.slice(0, 4),
  );
  await pool.query("DELETE FROM rate_boards WHERE id='board-close-stale'");
  for (const [currency, value] of [
    ["CAD", 25000],
    ["USD", 12000],
    ["EUR", 7000],
    ["GBP", 3500],
  ] as const) {
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, value],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':a.singh',now())`,
    scope,
  );
}

const book = async (cookies: Record<string, string>) =>
  (
    await app.inject({
      method: "GET",
      url: "/api/ledger/till-balances",
      cookies,
    })
  ).json() as { balanceGeneration?: string; balances: Record<string, string> };

/* The open session belongs to a.singh. A manager who does not hold it
   receives no amounts, so a count that has to match the book is read
   as the holder and then submitted by whoever the test is closing as. */
const holderBook = async () => book(await cookie());

async function priceYen() {
  await pool.query(
    `INSERT INTO rate_boards
      (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,published_at)
     VALUES ('board-close-stale',$1,$2,$3,0.02,0.03,$4::jsonb,clock_timestamp())
     ON CONFLICT (id) DO UPDATE SET board_rows=EXCLUDED.board_rows, published_at=clock_timestamp()`,
    [
      DEMO.tenantId,
      DEMO.legalEntityId,
      DEMO.branchId,
      JSON.stringify({ JPY: { mid: 0.0092 } }),
    ],
  );
}

const close = (
  cookies: Record<string, string>,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/till-sessions/session-1/close",
    cookies,
    payload: body,
  });

postgres("a till close after the drawer has moved", () => {
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
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await reset();
  });

  it("keeps a stored yen fraction on the balance and saves a zero variance", async () => {
    const teller = await cookie();
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',99.85)",
      scope,
    );
    const balances = await book(teller);
    expect(balances.balances.JPY).toBe("99.85");
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "jpy-fraction", counts: { JPY: "100.00" } },
    });
    expect(counted.statusCode).toBe(201);
    const row = await pool.query(
      `SELECT expected_amount, counted_amount, variance_amount, stored_expected_amount
         FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].expected_amount).toBe("99.85");
    expect(row.rows[0].stored_expected_amount).toBe("99.85");
    expect(row.rows[0].counted_amount).toBe("100.00");
    expect(row.rows[0].variance_amount).toBe("0.00");
    expect((await book(teller)).balances.JPY).toBe("99.85");
  });

  it("saves zero when the count matches yen rounded half up, and keeps the stored balance", async () => {
    const teller = await cookie();
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "jpy-489176", counts: { JPY: "489176.00" } },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    const row = await pool.query(
      `SELECT expected_amount, counted_amount, variance_amount, stored_expected_amount
         FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].expected_amount).toBe("489175.85");
    expect(row.rows[0].stored_expected_amount).toBe("489175.85");
    expect(row.rows[0].counted_amount).toBe("489176.00");
    expect(row.rows[0].variance_amount).toBe("0.00");
    expect((await book(teller)).balances.JPY).toBe("489175.85");
  });

  it("saves zero when a close counts the rounded yen", async () => {
    const manager = await cookie("r.haddad");
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await holderBook();
    const closed = await close(manager, {
      idempotencyKey: "close-yen-whole",
      counts: { ...counted.balances, JPY: "489176.00" },
      note: "yen on the grid",
      balanceGeneration: counted.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const row = await pool.query(
      `SELECT variance_amount, stored_expected_amount
         FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].stored_expected_amount).toBe("489175.85");
    expect(row.rows[0].variance_amount).toBe("0.00");
  });

  it("saves zero when a handover counts the rounded yen", async () => {
    const manager = await cookie("r.haddad");
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await holderBook();
    const handed = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/handover",
      cookies: manager,
      payload: {
        idempotencyKey: "handover-yen-whole",
        counts: { ...counted.balances, JPY: "489176.00" },
      },
    });
    expect(handed.statusCode, handed.body).toBe(201);
    const row = await pool.query(
      `SELECT b.count_kind, c.variance_amount, c.stored_expected_amount
         FROM ledger_till_counts c
         JOIN ledger_till_count_batches b ON b.batch_id = c.batch_id
        WHERE c.currency = 'JPY'`,
    );
    expect(row.rows[0].count_kind).toBe("close");
    expect(row.rows[0].stored_expected_amount).toBe("489175.85");
    expect(row.rows[0].variance_amount).toBe("0.00");
  });

  it("saves plus one when a close counts 489177", async () => {
    const manager = await cookie("r.haddad");
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await holderBook();
    const closed = await close(manager, {
      idempotencyKey: "close-yen-plus",
      counts: { ...counted.balances, JPY: "489177.00" },
      note: "one yen over",
      balanceGeneration: counted.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const row = await pool.query(
      `SELECT variance_amount FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].variance_amount).toBe("1.00");
  });

  it("saves minus one when a close counts 489175", async () => {
    const manager = await cookie("r.haddad");
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await holderBook();
    const closed = await close(manager, {
      idempotencyKey: "close-yen-minus",
      counts: { ...counted.balances, JPY: "489175.00" },
      note: "one yen short",
      balanceGeneration: counted.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const row = await pool.query(
      `SELECT variance_amount FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].variance_amount).toBe("-1.00");
  });

  it("saves plus one when a handover counts 489177", async () => {
    const manager = await cookie("r.haddad");
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    await priceYen();
    const counted = await holderBook();
    const handed = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/handover",
      cookies: manager,
      payload: {
        idempotencyKey: "handover-yen-plus",
        counts: { ...counted.balances, JPY: "489177.00" },
      },
    });
    expect(handed.statusCode, handed.body).toBe(201);
    const row = await pool.query(
      `SELECT variance_amount FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].variance_amount).toBe("1.00");
  });

  it("saves minus one when a handover counts 489175", async () => {
    const manager = await cookie("r.haddad");
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    await priceYen();
    const counted = await holderBook();
    const handed = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/handover",
      cookies: manager,
      payload: {
        idempotencyKey: "handover-yen-minus",
        counts: { ...counted.balances, JPY: "489175.00" },
      },
    });
    expect(handed.statusCode, handed.body).toBe(201);
    const row = await pool.query(
      `SELECT variance_amount FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].variance_amount).toBe("-1.00");
  });

  it("saves one yen when the count is one above the rounded expected", async () => {
    const teller = await cookie();
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "jpy-489177", counts: { JPY: "489177.00" } },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    const row = await pool.query(
      `SELECT variance_amount, stored_expected_amount
         FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].stored_expected_amount).toBe("489175.85");
    expect(row.rows[0].variance_amount).toBe("1.00");
    expect((await book(teller)).balances.JPY).toBe("489175.85");
    expect(counted.json().latestCounts.JPY).toMatchObject({
      expected: "489175.85",
      counted: "489177.00",
      variance: "1.00",
      storedExpected: "489175.85",
    });
  });

  it("saves minus one yen when the count is one below the rounded expected", async () => {
    const teller = await cookie();
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "jpy-489175", counts: { JPY: "489175.00" } },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    const row = await pool.query(
      `SELECT variance_amount, stored_expected_amount
         FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].stored_expected_amount).toBe("489175.85");
    expect(row.rows[0].variance_amount).toBe("-1.00");
    expect((await book(teller)).balances.JPY).toBe("489175.85");
    expect(counted.json().latestCounts.JPY.storedExpected).toBe("489175.85");
    expect(counted.json().latestCounts.JPY.variance).toBe("-1.00");
  });

  it("refuses an update to the stored expected, and keeps the saved figure", async () => {
    const teller = await cookie();
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',489175.85)",
      scope,
    );
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "jpy-write-once", counts: { JPY: "489176.00" } },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    await expect(
      pool.query(
        "UPDATE ledger_till_counts SET stored_expected_amount = 0 WHERE currency = 'JPY'",
      ),
    ).rejects.toThrow(/append-only/);
    const row = await pool.query(
      `SELECT stored_expected_amount, variance_amount
         FROM ledger_till_counts WHERE currency = 'JPY'`,
    );
    expect(row.rows[0].stored_expected_amount).toBe("489175.85");
    expect(row.rows[0].variance_amount).toBe("0.00");
  });

  it("leaves an old count null and does not recalculate its variance", async () => {
    await pool.query(
      "DELETE FROM schema_migrations WHERE migration_id = '048_till_count_stored_expected'",
    );
    await pool.query("ALTER TABLE ledger_till_counts DROP COLUMN stored_expected_amount");
    try {
      await pool.query(
        `INSERT INTO ledger_till_count_batches
          (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
           till_id,count_kind,actor_id,idempotency_key,counted_at)
         VALUES ('batch-old','session-1',$1,$2,$3,$4,$5,'interim',$1||':a.singh','old-count',now())`,
        scope,
      );
      await pool.query(
        `INSERT INTO ledger_till_counts
          (batch_id,currency,expected_amount,counted_amount,variance_amount)
         VALUES ('batch-old','JPY',99.85,100.00,0.15)`,
      );
      await runMigrations(pool);
      const row = await pool.query(
        `SELECT stored_expected_amount, variance_amount
           FROM ledger_till_counts WHERE batch_id = 'batch-old'`,
      );
      expect(row.rows[0].stored_expected_amount).toBeNull();
      expect(row.rows[0].variance_amount).toBe("0.15");
      const teller = await cookie();
      const session = await app.inject({
        method: "GET",
        url: "/api/ledger/till-session",
        cookies: teller,
      });
      expect(session.statusCode, session.body).toBe(200);
      expect(session.json().latestCounts.JPY.storedExpected).toBeNull();
      expect(session.json().latestCounts.JPY.variance).toBe("0.15");
    } finally {
      await runMigrations(pool);
    }
  });

  it("keeps a two-decimal variance and still refuses a three-decimal count", async () => {
    const teller = await cookie();
    await pool.query(
      `UPDATE ledger_till_balances SET available_amount = 99.85
        WHERE tenant_id=$1 AND till_id=$2 AND currency='CAD'`,
      [scope[0], scope[4]],
    );
    const cad = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "cad-fraction", counts: { CAD: "100.00" } },
    });
    expect(cad.statusCode, cad.body).toBe(201);
    const cadRow = await pool.query(
      `SELECT expected_amount, variance_amount, stored_expected_amount
         FROM ledger_till_counts WHERE currency = 'CAD'`,
    );
    expect(cadRow.rows[0].expected_amount).toBe("99.85");
    expect(cadRow.rows[0].stored_expected_amount).toBe("99.85");
    expect(cadRow.rows[0].variance_amount).toBe("0.15");
    expect((await book(teller)).balances.CAD).toBe("99.85");

    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'KWD',1.23)",
      scope,
    );
    const kwd = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "kwd-count", counts: { KWD: "1.24" } },
    });
    expect(kwd.statusCode, kwd.body).toBe(422);
    expect(kwd.json().code).toBe("UNSUPPORTED_CURRENCY");
  });

  it("refuses a fractional yen count", async () => {
    const teller = await cookie();
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',99.85)",
      scope,
    );
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "jpy-cents", counts: { JPY: "100.50" } },
    });
    expect(counted.statusCode, counted.body).toBe(422);
    expect(counted.json().code).toBe("INVALID_REQUEST");
    expect(counted.json().message).toBe(
      "Count is not a whole number of JPY. JPY has no minor unit.",
    );
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_till_counts")).rows[0].n,
    ).toBe(0);
  });

  it("answers a bad count or any comma with 422 on the count and close routes, and changes nothing (#558)", async () => {
    const teller = await cookie();
    const manager = await cookie("r.haddad");
    const before = await holderBook();
    for (const [n, bad] of REFUSED_COUNTS.entries()) {
      const counted = await app.inject({
        method: "POST",
        url: "/api/ledger/till-counts",
        cookies: teller,
        payload: { idempotencyKey: `count-${n}`, counts: { CAD: bad } },
      });
      expect(counted.statusCode, `count ${bad}: ${counted.body}`).toBe(422);
      expect(counted.body).not.toContain(bad);
      const closed = await close(manager, {
        idempotencyKey: `close-${n}`,
        counts: { ...before.balances, CAD: bad },
        balanceGeneration: before.balanceGeneration,
      });
      expect(closed.statusCode, `close ${bad}: ${closed.body}`).toBe(422);
      expect(closed.body).not.toContain(bad);
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_till_counts")).rows[0].n).toBe(0);
    const open = await pool.query("SELECT status FROM ledger_till_sessions WHERE session_id='session-1'");
    expect(open.rows).toEqual([{ status: "open" }]);
    expect((await holderBook()).balances).toEqual(before.balances);
  });

  it("refuses a count typed with thousands commas, and stores a plain one exactly", async () => {
    const teller = await cookie();
    const grouped = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "grouped-count", counts: { CAD: "1,000.50" } },
    });
    expect(grouped.statusCode, grouped.body).toBe(422);
    expect(grouped.json()).toEqual({ code: "INVALID_REQUEST", message: "A count must be the digits 0 to 9 and at most the currency's decimal places, with no commas." });
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: { idempotencyKey: "plain-count", counts: { CAD: "1000.50" } },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    const row = await pool.query("SELECT counted_amount::text AS counted FROM ledger_till_counts WHERE currency='CAD'");
    expect(row.rows).toEqual([{ counted: "1000.50" }]);
  });

  it("asks who is calling before it reads a count or a close (#558)", async () => {
    const count = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      payload: { idempotencyKey: "anon-count", counts: { CAD: "1500²" } },
    });
    expect(count.statusCode, count.body).toBe(401);
    expect(count.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    const closed = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/session-1/close",
      payload: { idempotencyKey: "anon-close", counts: { CAD: "1,500" }, balanceGeneration: "1" },
    });
    expect(closed.statusCode, closed.body).toBe(401);
    expect(closed.json()).toEqual({ code: "AUTHENTICATION_REQUIRED" });
    const unmarked = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/session-1/close",
      payload: { idempotencyKey: "anon-unmarked", counts: { CAD: "1,500" } },
    });
    expect(unmarked.statusCode, unmarked.body).toBe(401);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_till_counts")).rows[0].n).toBe(0);
  });

  it("refuses a till close when money moved after the count", async () => {
    const teller = await cookie();
    const manager = await cookie("r.haddad");
    const counted = await book(teller);

    const deal = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: teller,
      payload: {
        idempotencyKey: "deal-after-count",
        customerId: "customer-demo",
        from: "CAD",
        to: "USD",
        inputAmount: "40.00",
        feeCad: "0.00",
        purpose: "Travel",
        sourceOfFunds: "Cash",
      },
    });
    expect(deal.statusCode, deal.body).toBe(201);
    const afterDeal = await book(teller);
    expect(afterDeal.balances.CAD).toBe("25040.00");

    const closed = await close(manager, {
      idempotencyKey: "close-stale",
      counts: counted.balances,
      note: "counted before the deal",
      balanceGeneration: counted.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(422);
    expect(closed.json().message).toBe("Money moved since you counted. Count again.");
    expect((await book(teller)).balances).toEqual(afterDeal.balances);
    expect(
      (
        await pool.query(
          "SELECT status FROM ledger_till_sessions WHERE session_id='session-1'",
        )
      ).rows[0].status,
    ).toBe("open");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM ledger_till_count_batches WHERE count_kind='close'",
        )
      ).rows[0].n,
    ).toBe(0);

    const recounted = await book(teller);
    const accepted = await close(manager, {
      idempotencyKey: "close-fresh",
      counts: recounted.balances,
      note: "counted again",
      balanceGeneration: recounted.balanceGeneration,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().session.status).toBe("closed");
    expect((await book(manager)).balances.CAD).toBe("25040.00");
  });

  it("tells an old tab to reload when the close names no mark", async () => {
    const manager = await cookie("r.haddad");
    const counted = await holderBook();
    /* A tab opened before this mark existed posts the close it always
       posted: the counts, and no balanceGeneration. That used to come
       back as a bare validation code. */
    const closed = await close(manager, {
      idempotencyKey: "close-no-mark",
      counts: counted.balances,
      note: "opened before the mark existed",
    });
    expect(closed.statusCode, closed.body).toBe(422);
    expect(closed.json().message).toBe(
      "The desk was updated. Reload, then count again.",
    );
    expect((await holderBook()).balances).toEqual(counted.balances);
    expect(
      (
        await pool.query(
          "SELECT status FROM ledger_till_sessions WHERE session_id='session-1'",
        )
      ).rows[0].status,
    ).toBe("open");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM ledger_till_count_batches WHERE count_kind='close'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("still closes when nothing moved after the count", async () => {
    const manager = await cookie("r.haddad");
    const counted = await holderBook();
    const closed = await close(manager, {
      idempotencyKey: "close-quiet",
      counts: counted.balances,
      note: "quiet close",
      balanceGeneration: counted.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().session.status).toBe("closed");
    expect((await book(manager)).balances).toEqual(counted.balances);
  });
});
