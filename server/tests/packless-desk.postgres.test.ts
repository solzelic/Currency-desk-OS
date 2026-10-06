/* A desk whose country has no pack can be signed in to. It cannot post.
   Not a quote, not an exchange, not a transfer, not a frozen quote, and
   not an owner moving the identification line. Verified or not, and at
   one cent. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { LedgerError, LedgerService, type LedgerActor } from "../src/ledger/service.js";
import { DEMO, seed } from "../src/seed.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle, service: LedgerService;

const scope = [
  DEMO.tenantId,
  DEMO.legalEntityId,
  DEMO.branchId,
  DEMO.workspaceId,
  "till-01",
];

const teller: LedgerActor = {
  userId: `${DEMO.tenantId}:m.costa`,
  tenantId: DEMO.tenantId,
  legalEntityId: DEMO.legalEntityId,
  branchId: DEMO.branchId,
  workspaceId: DEMO.workspaceId,
  tillId: "till-01",
  role: "teller",
  authorizedBranchIds: [DEMO.branchId],
};

const quoteBody = {
  customerId: "customer-demo",
  from: "CAD",
  to: "USD",
  inputAmount: "0.01",
  feeCad: "0.00",
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
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE",
  );
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  /* RSD is not one of the currencies migration 028 backfills, so this
     desk stays without a pack. */
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'Packless desk','RSD',NULL,NULL)
     ON CONFLICT (id) DO UPDATE
       SET home_currency='RSD',
           jurisdiction_pack_id=NULL,
           jurisdiction_pack_version=NULL`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    `INSERT INTO ledger_principals VALUES
       ($1||':m.costa',$1,$2,$3,$4,$5,'teller','["br-yorkville"]'),
       ($1||':j.masri',$1,$2,$3,$4,$5,'administrator','["br-yorkville"]')`,
    scope,
  );
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','unverified')",
    scope.slice(0, 4),
  );
  for (const [currency, value] of [
    ["CAD", 25000],
    ["USD", 12000],
    ["RSD", 25000],
  ] as const)
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, value],
    );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-packless',$1,$2,$3,$4,$5,1,current_date,'open',$1||':m.costa',now())`,
    scope,
  );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('snap-packless','test','{\"USD\":1.4}',now())",
  );
  await pool.query(
    `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
     VALUES ('board-packless',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','snap-packless',now())`,
    scope.slice(0, 3),
  );
  await pool.query("INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.731)", scope.slice(0, 4));
}

async function expectPaused(response: { statusCode: number; json: () => { code?: string } }) {
  expect(response.statusCode).toBe(422);
  expect(response.json().code).toBe("no_jurisdiction_pack");
  const posted = await pool.query("SELECT count(*) FROM ledger_transactions");
  expect(posted.rows[0].count).toBe("0");
}

postgres("a desk with no pack cannot post", () => {
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
    service = new LedgerService(pool);
  });
  afterAll(async () => {
    /* This file points the shared demo desk at no pack. Put Canada back
       so a later file that posts at that desk is still posting in Canada. */
    await pool.query(
      `UPDATE legal_entities
          SET home_currency='CAD',
              jurisdiction_pack_id='pack-ca-v1',
              jurisdiction_pack_version=1
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });
  beforeEach(reset);

  it("refuses a quote, an exchange and a transfer for an unverified customer at 0.01", async () => {
    await expectPaused(
      await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: quoteBody,
      }),
    );
    await expect(service.post(teller, {
      idempotencyKey: "packless-exchange",
      customerId: "customer-demo",
      from: "CAD",
      to: "USD",
      inputAmount: "0.01",
      feeCad: "0.00",
      purpose: "Travel",
      sourceOfFunds: "Cash",
    })).rejects.toMatchObject({ code: "no_jurisdiction_pack" });
    await expectPaused(
      await app.inject({
        method: "POST",
        url: "/api/ledger/remittances/send",
        cookies: await cookie(),
        payload: {
          idempotencyKey: "packless-send",
          customerId: "customer-demo",
          reference: "RM-1",
          principalAmount: "0.01",
          feeAmount: "0.00",
          payoutCurrency: "USD",
          payoutAmount: "0.01",
          corridor: "US",
          partner: "Corridor partner",
          beneficiaryName: "Ann Beneficiary",
          purpose: "Family support",
          sourceOfFunds: "Salary",
        },
      }),
    );
  });

  it("refuses the same paths for a verified customer", async () => {
    await pool.query(
      "UPDATE ledger_customers SET id_status='verified' WHERE customer_id='customer-demo'",
    );
    await expectPaused(
      await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookie(),
        payload: quoteBody,
      }),
    );
    await expect(service.post(teller, {
      idempotencyKey: "packless-verified",
      customerId: "customer-demo",
      from: "CAD",
      to: "USD",
      inputAmount: "0.01",
      feeCad: "0.00",
      purpose: "Travel",
      sourceOfFunds: "Cash",
    })).rejects.toBeInstanceOf(LedgerError);
    await expect(service.post(teller, {
      idempotencyKey: "packless-verified",
      customerId: "customer-demo",
      from: "CAD",
      to: "USD",
      inputAmount: "0.01",
      feeCad: "0.00",
      purpose: "Travel",
      sourceOfFunds: "Cash",
    })).rejects.toMatchObject({ code: "no_jurisdiction_pack" });
    await expectPaused(
      await app.inject({
        method: "POST",
        url: "/api/ledger/remittances/send",
        cookies: await cookie(),
        payload: {
          idempotencyKey: "packless-send-verified",
          customerId: "customer-demo",
          reference: "RM-2",
          principalAmount: "0.01",
          feeAmount: "0.00",
          payoutCurrency: "USD",
          payoutAmount: "0.01",
          corridor: "US",
          partner: "Corridor partner",
          beneficiaryName: "Ann Beneficiary",
        },
      }),
    );
  });

  it("refuses a frozen quote that was priced before the pack was gone", async () => {
    await pool.query(
      `UPDATE legal_entities
          SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    const made = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: await cookie(),
      payload: { ...quoteBody, inputAmount: "100.00", feeCad: "0.00" },
    });
    expect(made.statusCode).toBe(201);
    const quote = made.json();
    await pool.query(
      `UPDATE legal_entities
          SET home_currency='RSD', jurisdiction_pack_id=NULL, jurisdiction_pack_version=NULL
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    await expectPaused(
      await app.inject({
        method: "POST",
        url: `/api/quotes/${quote.quoteId}/post`,
        cookies: await cookie(),
        payload: {
          idempotencyKey: "packless-frozen",
          purpose: "Personal travel",
          sourceOfFunds: "Employment income",
        },
      }),
    );
  });

  it("refuses an owner override while there is no pack", async () => {
    const changed = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      cookies: await cookie("j.masri"),
      payload: { idThreshold: "1000.00" },
    });
    expect(changed.statusCode).toBe(422);
    expect(changed.json().code).toBe("no_jurisdiction_pack");
    const row = await pool.query(
      "SELECT id_threshold FROM legal_entities WHERE id=$1",
      [DEMO.legalEntityId],
    );
    expect(row.rows[0].id_threshold).toBeNull();
  });
});
