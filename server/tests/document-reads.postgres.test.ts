/* ============================================================
   The two reads a signed document needs, and could not get.

   The End-of-Day Sign-Off sheet has a panel headed "Earnings by teller".
   It was summed in the browser, over that browser's copy of the last
   hundred transactions, with the margin re-estimated against a live
   market mid — and on a desk where one person had traded once and voided
   it, the sheet named three tellers with money beside each of them.

   The filing worksheet has a field the regulator's acknowledgement number
   is pasted into. It was labelled "FWR acknowledgement #", FWR being the
   name of Canada's portal, on a desk in Dubai that files into goAML. The
   pack has carried `jurisdiction_reports.filing_format` since migration
   012 and nothing served it.

   Both are now on the server, and both follow the same null rule as
   everything else in LedgerReportingService: a figure the ledger cannot
   source comes back null, never zero. See docs/ABSENT_FIGURES.md and
   docs/GENERATED_DOCUMENTS.md.
   ============================================================ */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;

const TILL = "till-01";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, TILL];

async function cookie(staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  expect(login.statusCode, `${staffId} could not sign in`).toBe(200);
  return {
    cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value,
  };
}

/* Two people on the same drawer, so "earnings by teller" has more than one
   teller to be right about. Both are made branch managers on the same
   workspace: what is being tested is the GROUP BY, not authorization. */
const TELLERS = ["r.haddad", "a.singh"];

async function reset(homeCurrency = "CAD", packId = "pack-ca-v1") {
  await pool.query(
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE",
  );
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York FX',$3,$4,1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id=$4, home_currency=$3`,
    [DEMO.legalEntityId, DEMO.tenantId, homeCurrency, packId],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  for (const staff of TELLERS) {
    await pool.query(
      `INSERT INTO ledger_principals
        (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
       VALUES ($1||':'||$6,$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]')`,
      [...scope, staff],
    );
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "branch_manager", authorizedBranchIds: [DEMO.branchId] })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:${staff}`));
  }
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified')",
    scope.slice(0, 4),
  );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('doc-session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':r.haddad',now())`,
    scope,
  );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('doc-snap','test','{\"USD\":1.4}',now())",
  );
  await pool.query(
    `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
     VALUES ('doc-board',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','doc-snap',now())`,
    scope.slice(0, 3),
  );
}

async function tillHolds(currency: string, amount: number, avgCost?: string) {
  await pool.query(
    `INSERT INTO ledger_till_balances
      (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount,avg_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING`,
    [...scope, currency, amount, avgCost ?? null],
  );
}

/* 1,443.30 CAD at the board's 1.40 mid and 3% sell margin buys exactly a
   thousand US dollars — the same round figure ledger-reporting uses, so the
   arithmetic below stays readable. */
async function sellAThousandDollars(staffId: string, key: string, feeCad: string) {
  const cookies = await cookie(staffId);
  const quote = (
    await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies,
      payload: {
        customerId: "customer-demo",
        from: "CAD",
        to: "USD",
        inputAmount: "1443.30",
        feeCad,
        direction: "customer_buy_foreign",
      },
    })
  ).json();
  expect(quote.outputAmount).toBe("1000.00");
  const posted = await app.inject({
    method: "POST",
    url: `/api/quotes/${quote.quoteId}/post`,
    cookies,
    payload: { idempotencyKey: key, purpose: "Personal travel", sourceOfFunds: "Employment income" },
  });
  expect(posted.statusCode, posted.body).toBe(201);
  return posted.json().transactionId as string;
}

const summary = async (staffId = "r.haddad") =>
  (
    await app.inject({
      method: "GET",
      url: "/api/ledger/summary",
      cookies: await cookie(staffId),
    })
  ).json();

const jurisdiction = async () =>
  (
    await app.inject({
      method: "GET",
      url: "/api/ledger/jurisdiction",
      cookies: await cookie("r.haddad"),
    })
  ).json();

postgres("the reads a signed document is built from", () => {
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

  beforeEach(() => reset());

  /* ---- EARNINGS BY TELLER ---- */

  /* Nobody traded, so nobody earned — and the answer is an EMPTY LIST, not
     a list of tellers with zeros beside them. The sign-off sheet renders
     this as "Nobody posted a deal at this till on this trading day", which
     is a sentence a manager can sign under. */
  it("attributes nothing to nobody when nothing was posted", async () => {
    const empty = await summary();
    expect(empty.posted).toBe(0);
    expect(empty.byActor).toEqual([]);
  });

  it("attributes each deal to the person the ledger recorded", async () => {
    await tillHolds("CAD", 50000);
    await tillHolds("USD", 4000, "1.340000000000");
    await sellAThousandDollars("r.haddad", "doc-actor-1", "4.00");
    await sellAThousandDollars("a.singh", "doc-actor-2", "6.00");
    await sellAThousandDollars("a.singh", "doc-actor-3", "0.00");

    const three = await summary();
    expect(three.posted).toBe(3);
    expect(three.byActor).toHaveLength(2);

    const by = Object.fromEntries(
      three.byActor.map((a: { actorId: string }) => [a.actorId.split(":").pop(), a]),
    );
    /* One deal, four dollars of commission, and the margin the disposal
       booked: 1,443.30 in against a thousand dollars that cost 1.34 each. */
    expect(by["r.haddad"]).toMatchObject({
      deals: 1,
      volumeHome: "1443.30",
      feesHome: "4.00",
      realizedPnlHome: "103.30",
      earningsHome: "107.30",
      pricedDeals: 1,
    });
    /* Two deals for the other teller, and the totals are exactly the sum —
       this is the assertion that would have caught a browser-side panel
       drifting from the book, because both halves are checkable. */
    expect(by["a.singh"]).toMatchObject({
      deals: 2,
      volumeHome: "2886.60",
      feesHome: "6.00",
      pricedDeals: 2,
    });

    /* And the per-teller figures reconcile to the headline. A panel that
       adds up to something other than the total above it is the shape of
       wrong that survives every test written on one side only. */
    const totalFees = three.byActor.reduce(
      (sum: number, a: { feesHome: string | null }) => sum + Number(a.feesHome ?? 0),
      0,
    );
    expect(totalFees.toFixed(2)).toBe(three.feesHome);
    const totalEarned = three.byActor.reduce(
      (sum: number, a: { earningsHome: string | null }) => sum + Number(a.earningsHome ?? 0),
      0,
    );
    expect(totalEarned.toFixed(2)).toBe(three.earningsHome);
  });

  /* A void is a deal that did not happen, not one that earned nothing. It
     leaves the teller's row entirely rather than dragging it toward zero —
     the close-out sheet that started all this said "Earned today $223.00"
     for a till whose only deal had been reversed. */
  it("drops a reversed deal from its teller's earnings entirely", async () => {
    await tillHolds("CAD", 50000);
    await tillHolds("USD", 4000, "1.340000000000");
    const transactionId = await sellAThousandDollars("r.haddad", "doc-void-1", "4.00");

    const reversed = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${transactionId}/reversal`,
      cookies: await cookie("r.haddad"),
      payload: { idempotencyKey: "doc-void-1-rev", reason: "Document seam" },
    });
    expect(reversed.statusCode, reversed.body).toBe(201);

    const after = await summary();
    expect(after.posted).toBe(0);
    expect(after.reversed).toBe(1);
    /* Not a row of zeros. Not a row at all. */
    expect(after.byActor).toEqual([]);
    expect(after.earningsHome).toBeNull();
  });

  /* A teller's earnings are commission plus the margin the disposal booked,
     and the two are separable — the sign-off sheet prints them as separate
     columns so a reader can see which is which.

     NOTE, and it is worth knowing before signing one of these sheets: where
     the box held stock with no recorded basis, `ensureBasis` in
     cost-basis.ts writes an `opening_estimated` basis at the board's rate
     rather than refusing to price the sale, and the disposal then books a
     real-looking `realized_pnl_home` against it. That figure is margin
     against an ESTIMATE, and neither `summary()` nor the sheet distinguishes
     it from margin against a cost the desk actually paid. The estimate is
     queryable (`ledger_cost_events.event_kind = 'opening_estimated'`, which
     is why it is recorded that way) but it is not surfaced. Asserted here as
     the behaviour that exists, so a change to it is a failing test rather
     than a quiet shift in what a signed document claims. */
  it("splits a teller's earnings into commission and booked margin", async () => {
    await tillHolds("CAD", 50000);
    await tillHolds("USD", 4000);   // held, with no basis on record
    await sellAThousandDollars("r.haddad", "doc-unpriced-1", "9.00");

    const one = await summary();
    expect(one.posted).toBe(1);
    const [actor] = one.byActor;
    expect(actor.deals).toBe(1);
    expect(actor.feesHome).toBe("9.00");
    /* Priced, because a basis was estimated for the stock at the board's
       own rate — not because anybody recorded what these dollars cost. */
    expect(actor.pricedDeals).toBe(1);
    expect(Number(actor.earningsHome)).toBeCloseTo(
      9 + Number(actor.realizedPnlHome),
      2,
    );
    /* And the estimate is on the record where it can be found and
       corrected, which is the property that makes the figure above
       defensible at all. */
    const estimated = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_cost_events WHERE event_kind='opening_estimated'",
    );
    expect(estimated.rows[0].n).toBeGreaterThan(0);
  });

  /* ---- THE PACK'S OWN FORMS ---- */

  it("serves the forms this desk has to file, and where they go", async () => {
    const canada = await jurisdiction();
    expect(canada.pack.homeCurrency).toBe("CAD");
    expect(canada.pack.regulator).toBe("FINTRAC");

    const byCode = Object.fromEntries(
      canada.reports.map((r: { code: string }) => [r.code, r]),
    );
    expect(Object.keys(byCode).sort()).toEqual(["EFTR", "LCTR", "STR"]);
    expect(byCode.LCTR).toMatchObject({
      name: "Large Cash Transaction Report",
      kind: "large_cash",
      triggerThreshold: "10000.00",
      triggerCurrency: "CAD",
      aggregationHours: 24,
      filingFormat: "FWR JSON batch",
    });
    /* A suspicious-transaction report is raised by a person, not by
       arithmetic, so it has no threshold and no aggregation window — null,
       not zero, for the same reason as everything else here. */
    expect(byCode.STR.triggerThreshold).toBeNull();
    expect(byCode.STR.aggregationHours).toBeNull();

    /* EMPTY ON PURPOSE, and it must stay that way until somebody
       transcribes the real form. Migration 012 is explicit about why: an
       empty list is honestly "not transcribed yet", where a guessed one
       would be a form that looks official and is wrong. A screen must
       render this as a gap, never as a form with no fields. */
    expect(byCode.LCTR.fields).toEqual([]);
  });

  it("answers with the desk's own country, not with Canada's", async () => {
    await reset("GBP", "pack-gb-v1");
    const london = await jurisdiction();
    expect(london.pack.homeCurrency).toBe("GBP");
    expect(london.pack.regulator).not.toBe("FINTRAC");
    /* The whole point: a London desk has no LCTR to file and no FWR to
       file it into, so a worksheet naming either is naming Canada's. */
    const codes = london.reports.map((r: { code: string }) => r.code);
    expect(codes).not.toContain("LCTR");
    expect(codes).toContain("MLR");
    const mlr = london.reports.find((r: { code: string }) => r.code === "MLR");
    expect(mlr.filingFormat).toBe("NCA SAR Online");
    expect(mlr.filingFormat).not.toContain("FWR");
  });

  /* And the summary is denominated in the desk's own money too — the
     `homeCurrency` every document labels its figures with. */
  it("denominates the summary in the entity's own home currency", async () => {
    await reset("GBP", "pack-gb-v1");
    const london = await summary();
    expect(london.homeCurrency).toBe("GBP");
  });
});
