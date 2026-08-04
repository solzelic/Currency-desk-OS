/* ============================================================
   A customer walks in with dollars and wants euros.

   Until now the desk had to do that twice — sell the dollars for home
   currency, buy the euros back — because a quote carried one rate and the
   posting path insisted the home currency be on one side of every
   exchange. That was the pilot's limitation, not anybody's rule.

   A cross is two board rows off one publication, both frozen; two sides of
   inventory rather than one; and a margin taken twice, which is exactly
   what the desk would have earned had the customer done it as two deals.
   What it is NOT is a licence to book the whole proceeds as profit: the
   currency going out leaves at what it cost, and the difference between
   that and what arrived is the only thing that gets called earnings.

   These tests hold that, and hold the things a reader would get wrong:
   that BOTH mids have to be tamper-checked, that the journal balances when
   the desk loses money as well as when it makes some, and that a
   jurisdiction which forbids the deal still forbids it.
   ============================================================ */
import pg from "pg";
import Decimal from "decimal.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import {
  LedgerService,
  type FrozenQuote,
  type LedgerActor,
} from "../src/ledger/service.js";
import { DEMO, seed } from "../src/seed.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;

const TILL = "till-01";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, TILL];

/** 1,000 USD in, euros out, with the fee charged separately in CAD. */
const cross = {
  customerId: "customer-demo",
  from: "USD",
  to: "EUR",
  inputAmount: "1000.00",
  feeCad: "4.00",
  direction: "customer_cross",
};

const postBody = (idempotencyKey: string) => ({
  idempotencyKey,
  purpose: "Personal travel",
  sourceOfFunds: "Employment income",
});

const actor: LedgerActor = {
  userId: `${DEMO.tenantId}:m.costa`,
  tenantId: DEMO.tenantId,
  legalEntityId: DEMO.legalEntityId,
  branchId: DEMO.branchId,
  workspaceId: DEMO.workspaceId,
  tillId: TILL,
  role: "teller",
  authorizedBranchIds: [DEMO.branchId],
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
  /* The suites share one database, so the vault and cost-event tables come
     out too — a stale basis left behind by another file would silently
     change what a disposal here realizes. */
  await pool.query(
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE",
  );
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1', home_currency='CAD'`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    "INSERT INTO ledger_principals VALUES ($1||':m.costa',$1,$2,$3,$4,$5,'teller','[\"br-yorkville\"]'),($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','[\"br-yorkville\"]')",
    scope,
  );
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified')",
    scope.slice(0, 4),
  );
  for (const [currency, amount] of [
    ["CAD", 25000],
    ["USD", 12000],
    ["EUR", 7000],
    ["GBP", 3500],
  ])
    await pool.query(
      "INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, amount],
    );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':m.costa',now())`,
    scope,
  );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('snap-1','test','{\"USD\":1.4,\"EUR\":1.5,\"GBP\":1.7}',now())",
  );
  // one publication, carrying every rate this deal is priced off
  await pool.query(
    'INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at) VALUES (\'board-1\',$1,$2,$3,0.02,0.03,\'{"USD":{"mid":1.4,"show":true},"EUR":{"mid":1.5,"show":true},"GBP":{"mid":1.7,"show":true}}\',\'snap-1\',now())',
    scope.slice(0, 3),
  );
}

/** Whatever the EUR drawer is carrying now, stated as a known cost. */
async function setEuroBasis(avgCost: string) {
  await pool.query(
    "UPDATE ledger_till_balances SET avg_cost=$1 WHERE till_id=$2 AND currency='EUR'",
    [avgCost, TILL],
  );
}

const quoteFor = async (payload: Record<string, unknown> = {}) =>
  (
    await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: await cookie(),
      payload: { ...cross, ...payload },
    })
  ).json();

const postQuote = async (quoteId: string, key: string) =>
  app.inject({
    method: "POST",
    url: `/api/quotes/${quoteId}/post`,
    cookies: await cookie(),
    payload: postBody(key),
  });

const journalOf = async (transactionId: string) =>
  (
    await pool.query(
      "SELECT account_code,side,amount_cad FROM ledger_journal_entries WHERE transaction_id=$1 ORDER BY entry_id",
      [transactionId],
    )
  ).rows;

const sideTotal = (rows: { side: string; amount_cad: string }[], side: string) =>
  rows
    .filter((r) => r.side === side)
    .reduce((sum, r) => sum.add(r.amount_cad), new Decimal(0));

const frozenFrom = (made: Record<string, string>): FrozenQuote =>
  ({
    quoteId: made.quoteId,
    customerId: cross.customerId,
    from: made.from,
    to: made.to,
    inputAmount: made.inputAmount,
    outputAmount: made.outputAmount,
    marketMid: made.marketMid,
    fromMid: made.fromMid,
    toMid: made.toMid,
    customerRate: made.customerRate,
    feeCad: made.feeCad,
    spreadCad: made.spreadCad,
    rateBoardPublicationId: made.rateBoardPublicationId,
    marketSnapshotId: made.marketSnapshotId,
    rateSourceType: made.rateSourceType,
    quoteOverrideId: null,
    purpose: "Personal travel",
    sourceOfFunds: "Employment income",
  }) as unknown as FrozenQuote;

postgres("one deal, two foreign currencies", () => {
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

  it("prices a cross off two rows of one publication and freezes both", async () => {
    const made = await quoteFor();
    expect(made.buyOrSellSide).toBe("we_cross");
    expect(made.fromMid).toBe("1.400000000000");
    expect(made.toMid).toBe("1.500000000000");
    /* `market_mid` still holds one rate, so everything downstream that
       reads it keeps working. On a cross it is the side the deal is
       valued on — the one that arrived. */
    expect(made.marketMid).toBe("1.400000000000");

    /* (1.4/1.5), less the buy margin on the dollars arriving and the sell
       margin on the euros leaving: 0.98 × 0.97. */
    const expected = new Decimal("1.4")
      .div("1.5")
      .mul(new Decimal("0.98").mul("0.97"));
    expect(new Decimal(made.customerRate).toFixed(12)).toBe(expected.toFixed(12));
    expect(made.outputAmount).toBe("887.23");
    // 1,000 USD at 1.40 is 1,400 of home value; the euros go out worth 1,330.85
    expect(made.spreadCad).toBe("69.15");

    const stored = await pool.query(
      "SELECT direction,from_mid,to_mid,market_mid FROM quotes WHERE quote_id=$1",
      [made.quoteId],
    );
    expect(stored.rows[0]).toMatchObject({
      direction: "customer_cross",
      from_mid: "1.400000000000",
      to_mid: "1.500000000000",
      market_mid: "1.400000000000",
    });
  });

  it("posts a USD to EUR deal whose journal balances", async () => {
    const made = await quoteFor();
    const posted = await postQuote(made.quoteId, "cross-post");
    expect(posted.statusCode).toBe(201);
    const transactionId = posted.json().transactionId;

    const rows = await journalOf(transactionId);
    expect(sideTotal(rows, "debit").toFixed(2)).toBe(
      sideTotal(rows, "credit").toFixed(2),
    );
    /* The euro drawer had no recorded basis, so the board mid it is priced
       against became its opening estimate — which makes the cost of the
       euros leaving exactly their home value, and the realized figure
       exactly the margin. */
    expect(rows).toEqual([
      { account_code: "till:USD", side: "debit", amount_cad: "1400.00" },
      { account_code: "till:CAD", side: "debit", amount_cad: "4.00" },
      { account_code: "till:EUR", side: "credit", amount_cad: "1330.85" },
      { account_code: "revenue:fx_trading", side: "credit", amount_cad: "69.15" },
      { account_code: "revenue:fee", side: "credit", amount_cad: "4.00" },
    ]);

    // three currencies actually moved: dollars in, euros out, fee in
    const movements = await pool.query(
      "SELECT currency,direction,amount FROM ledger_till_movements WHERE transaction_id=$1 ORDER BY currency",
      [transactionId],
    );
    expect(movements.rows).toEqual([
      { currency: "CAD", direction: "in", amount: "4.00" },
      { currency: "EUR", direction: "out", amount: "887.23" },
      { currency: "USD", direction: "in", amount: "1000.00" },
    ]);
    const balances = await pool.query(
      "SELECT currency,available_amount FROM ledger_till_balances WHERE till_id=$1 ORDER BY currency",
      [TILL],
    );
    expect(balances.rows).toEqual([
      { currency: "CAD", available_amount: "25004.00" },
      { currency: "EUR", available_amount: "6112.77" },
      { currency: "GBP", available_amount: "3500.00" },
      { currency: "USD", available_amount: "13000.00" },
    ]);
  });

  it("realizes the margin taken twice, measured against what the euros cost", async () => {
    /* The desk bought these euros at 1.20 and the board says 1.50, so it is
       carrying a holding gain as well as the margin. Both are earned at
       the moment of disposal and neither is earned before. */
    await setEuroBasis("1.200000000000");
    const made = await quoteFor();
    const posted = await postQuote(made.quoteId, "cross-cheap-euros");
    const transactionId = posted.json().transactionId;

    const tx = await pool.query(
      "SELECT realized_pnl_home,cost_of_sale_home,spread_cad FROM ledger_transactions WHERE transaction_id=$1",
      [transactionId],
    );
    // 887.23 euros that cost 1.20 each
    expect(tx.rows[0].cost_of_sale_home).toBe("1064.68");
    expect(tx.rows[0].realized_pnl_home).toBe("335.32");
    /* The margin is 69.15 of it. The rest — 887.23 × 0.30 — is what the
       desk made holding euros, and it is realized here rather than being
       booked the day the market moved. */
    expect(tx.rows[0].spread_cad).toBe("69.15");
    expect(
      new Decimal(tx.rows[0].realized_pnl_home).sub(tx.rows[0].spread_cad).toFixed(2),
    ).toBe("266.17");

    const rows = await journalOf(transactionId);
    expect(sideTotal(rows, "debit").toFixed(2)).toBe(
      sideTotal(rows, "credit").toFixed(2),
    );
    expect(rows).toContainEqual({
      account_code: "till:EUR",
      side: "credit",
      amount_cad: "1064.68",
    });

    /* Both sides moved a basis: the euros left at what they cost, and the
       dollars arrived at what the deal valued them at. */
    const events = await pool.query(
      "SELECT currency,event_kind,direction,unit_cost_home,realized_pnl_home FROM ledger_cost_events WHERE source_id=$1 ORDER BY currency",
      [transactionId],
    );
    expect(events.rows).toEqual([
      {
        currency: "EUR",
        event_kind: "sale",
        direction: "out",
        unit_cost_home: "1.200000000000",
        realized_pnl_home: "335.32",
      },
      {
        currency: "USD",
        event_kind: "purchase",
        direction: "in",
        unit_cost_home: "1.400000000000",
        realized_pnl_home: null,
      },
    ]);
  });

  it("books a loss as a loss, and the journal still balances", async () => {
    /* Euros bought at 1.60 and sold into a board of 1.50. The margin does
       not save it, and a book that netted this against the fee or hid it
       in the spread would be telling the desk it made money. */
    await setEuroBasis("1.600000000000");
    const made = await quoteFor();
    const posted = await postQuote(made.quoteId, "cross-expensive-euros");
    const transactionId = posted.json().transactionId;

    const tx = await pool.query(
      "SELECT realized_pnl_home,cost_of_sale_home FROM ledger_transactions WHERE transaction_id=$1",
      [transactionId],
    );
    expect(tx.rows[0].cost_of_sale_home).toBe("1419.57");
    expect(tx.rows[0].realized_pnl_home).toBe("-19.57");

    const rows = await journalOf(transactionId);
    // the loss is a DEBIT, and the totals close on the other side
    expect(rows).toContainEqual({
      account_code: "revenue:fx_trading",
      side: "debit",
      amount_cad: "19.57",
    });
    expect(sideTotal(rows, "debit").toFixed(2)).toBe("1423.57");
    expect(sideTotal(rows, "credit").toFixed(2)).toBe("1423.57");
  });

  it("rejects a cross whose from-mid OR to-mid has been moved", async () => {
    const service = new LedgerService(pool);
    /* One mid checked and one not is half a price check. Whichever one the
       tamper-check skipped is the one somebody would move. */
    for (const [field, changed] of [
      ["fromMid", "1.500000000000"],
      ["toMid", "1.400000000000"],
      ["fromMid", null],
      ["toMid", null],
    ] as const) {
      const made = await quoteFor();
      await expect(
        service.postFrozenQuote(
          actor,
          { ...frozenFrom(made), [field]: changed } as FrozenQuote,
          `cross-tamper-${field}-${changed}`,
        ),
      ).rejects.toMatchObject({ code: "QUOTE_MISMATCH" });
    }
    // and the untampered terms still post, so the check is not simply refusing
    const good = await quoteFor();
    await expect(
      service.postFrozenQuote(actor, frozenFrom(good), "cross-untampered"),
    ).resolves.toMatchObject({ quoteId: good.quoteId });
  });

  it("refuses the deal where the jurisdiction pack does not allow one", async () => {
    await pool.query(
      "UPDATE jurisdiction_packs SET allow_cross_currency=false WHERE pack_id='pack-ca-v1'",
    );
    try {
      const refused = await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: cross,
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe("UNSUPPORTED_CURRENCY_PAIR");
      // the refusal explains itself in the pack's own words
      expect(refused.json().message).toMatch(/CAD/);
      // and the ordinary deals this desk does all day are untouched
      const ordinary = await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: { ...cross, from: "CAD", to: "USD", direction: "customer_buy_foreign" },
      });
      expect(ordinary.statusCode).toBe(201);
    } finally {
      await pool.query(
        "UPDATE jurisdiction_packs SET allow_cross_currency=true WHERE pack_id='pack-ca-v1'",
      );
    }
  });

  it("refuses a cross the till cannot pay out, and posts nothing", async () => {
    await pool.query(
      "UPDATE ledger_till_balances SET available_amount='100.00' WHERE till_id=$1 AND currency='EUR'",
      [TILL],
    );
    const made = await quoteFor();
    const posted = await postQuote(made.quoteId, "cross-dry");
    expect(posted.statusCode).toBe(422);
    expect(posted.json().code).toBe("INSUFFICIENT_TILL_LIQUIDITY");
    expect(
      (await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0].count,
    ).toBe("0");
    /* Nothing half-happened: the dollars did not arrive and the euro drawer
       was not given an estimated basis on the way to being refused. */
    expect(
      (await pool.query("SELECT count(*) FROM ledger_cost_events")).rows[0].count,
    ).toBe("0");
    expect(
      (
        await pool.query(
          "SELECT available_amount FROM ledger_till_balances WHERE till_id=$1 AND currency='USD'",
          [TILL],
        )
      ).rows[0].available_amount,
    ).toBe("12000.00");
  });

  it("leaves a home-currency deal exactly as it was", async () => {
    const made = await quoteFor({
      from: "CAD",
      to: "USD",
      direction: "customer_buy_foreign",
    });
    // the mids stay null: one side IS the home currency, and its rate is 1
    expect(made.fromMid).toBeNull();
    expect(made.toMid).toBeNull();
    expect(made.buyOrSellSide).toBe("we_sell");
    expect(made.customerRate).toBe("0.692857142857");
    expect(made.outputAmount).toBe("692.86");

    const posted = await postQuote(made.quoteId, "home-unchanged");
    expect(posted.statusCode).toBe(201);
    const rows = await journalOf(posted.json().transactionId);
    expect(rows).toEqual([
      { account_code: "till:CAD", side: "debit", amount_cad: "1000.00" },
      { account_code: "till:CAD", side: "debit", amount_cad: "4.00" },
      // the dollars leave at what they cost, and the margin is what is left
      { account_code: "till:USD", side: "credit", amount_cad: "970.00" },
      { account_code: "revenue:fx_trading", side: "credit", amount_cad: "30.00" },
      { account_code: "revenue:fee", side: "credit", amount_cad: "4.00" },
    ]);
  });
});
