/* No country pack: the desk trades under the international baseline.
   Voids and settling existing deals still work. A quote can be priced.
   With no market mid for the home currency, an unverified customer is
   identified on every deal. Clearing a cheque already held, settling
   an obligation already open, and voiding a deal posted while a pack
   was installed all still post. Vault and till cash movements are not
   deals, and they still post. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { LedgerService, type LedgerActor } from "../src/ledger/service.js";
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
  from: "RSD",
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
  /* RSD is not a country pack. The row is left with no pack id so
     resolution has to pick the baseline. The snapshot has USD and not
     RSD, so a USD threshold cannot be priced and every unverified
     deal asks for identification. */
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

async function expectIdentified(response: { statusCode: number; json: () => { code?: string } }) {
  expect(response.statusCode).toBe(422);
  expect(response.json().code).toBe("COMPLIANCE_BLOCKED");
  expect(response.json().code).not.toBe("no_jurisdiction_pack");
}

postgres("a desk with no country pack uses the baseline", () => {
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

  it("quotes, and identifies every unverified deal when the market rate cannot price the home currency", async () => {
    const quoted = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: await cookie(),
      payload: quoteBody,
    });
    expect(quoted.statusCode, quoted.body).toBe(201);
    await expectIdentified(
      await app.inject({
        method: "POST",
        url: `/api/quotes/${quoted.json().quoteId}/post`,
        cookies: await cookie(),
        payload: {
          idempotencyKey: "packless-post",
          purpose: "Travel",
          sourceOfFunds: "Cash",
        },
      }),
    );
    await expectIdentified(
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
    const posted = await pool.query("SELECT count(*) FROM ledger_transactions");
    expect(posted.rows[0].count).toBe("0");
  });

  it("posts a verified deal under the baseline and does not name FINTRAC", async () => {
    await pool.query(
      "UPDATE ledger_customers SET id_status='verified' WHERE customer_id='customer-demo'",
    );
    const sent = await app.inject({
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
        purpose: "Family support",
        sourceOfFunds: "Salary",
      },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const row = (
      await pool.query(
        `SELECT jurisdiction_pack_id, home_currency, compliance_threshold_rate
           FROM ledger_transactions WHERE transaction_id=$1`,
        [sent.json().transactionId],
      )
    ).rows[0];
    expect(row.jurisdiction_pack_id).toBe("pack-intl-v1");
    expect(String(row.home_currency).trim()).toBe("RSD");
    expect(row.compliance_threshold_rate).toBeNull();
    const pack = await pool.query(
      "SELECT regulator FROM jurisdiction_packs WHERE pack_id='pack-intl-v1'",
    );
    expect(pack.rows[0].regulator).toBe("");
    expect(pack.rows[0].regulator).not.toBe("FINTRAC");
  });

  it("posts a frozen quote under the baseline after the country pack is removed", async () => {
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
      payload: {
        customerId: "customer-demo",
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "0.00",
        direction: "customer_buy_foreign",
      },
    });
    expect(made.statusCode).toBe(201);
    const quote = made.json();
    await pool.query(
      `UPDATE legal_entities
          SET jurisdiction_pack_id=NULL, jurisdiction_pack_version=NULL
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    const posted = await app.inject({
      method: "POST",
      url: `/api/quotes/${quote.quoteId}/post`,
      cookies: await cookie(),
      payload: {
        idempotencyKey: "packless-frozen",
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
      },
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const stamp = (
      await pool.query(
        "SELECT jurisdiction_pack_id FROM ledger_transactions WHERE transaction_id=$1",
        [posted.json().transactionId],
      )
    ).rows[0];
    expect(stamp.jurisdiction_pack_id).toBe("pack-intl-v1");
  });

  it("lets an owner set a threshold on a baseline desk", async () => {
    const changed = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      cookies: await cookie("j.masri"),
      payload: { idThreshold: "1000.00" },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const row = await pool.query(
      "SELECT id_threshold FROM legal_entities WHERE id=$1",
      [DEMO.legalEntityId],
    );
    expect(row.rows[0].id_threshold).toBe("1000.00");
  });

  it("identifies an unverified cheque, remittance receive, bill payment and money order when the rate is missing", async () => {
    await expectIdentified(await app.inject({
      method: "POST",
      url: "/api/ledger/cheques",
      cookies: await cookie(),
      payload: {
        idempotencyKey: "packless-cheque",
        customerId: "customer-demo",
        chequeNumber: "1001",
        maker: "Demo Customer",
        chequeType: "personal",
        typeLabel: "Personal",
        currency: "RSD",
        faceAmount: "0.01",
        feeAmount: "0.00",
        holdDays: 0,
      },
    }));
    await expectIdentified(await app.inject({
      method: "POST",
      url: "/api/ledger/remittances/receive",
      cookies: await cookie(),
      payload: {
        idempotencyKey: "packless-receive",
        customerId: "customer-demo",
        reference: "RR-1",
        sentCurrency: "USD",
        sentAmount: "0.01",
        payoutAmount: "0.01",
        feeAmount: "0.00",
        corridor: "US",
        partner: "Corridor partner",
      },
    }));
    await expectIdentified(await app.inject({
      method: "POST",
      url: "/api/ledger/bill-payments",
      cookies: await cookie(),
      payload: {
        idempotencyKey: "packless-bill",
        customerId: "customer-demo",
        reference: "BP-1",
        billAmount: "0.01",
        feeAmount: "0.00",
        biller: "Hydro",
        accountRef: "acct-1",
      },
    }));
    await expectIdentified(await app.inject({
      method: "POST",
      url: "/api/ledger/money-orders",
      cookies: await cookie(),
      payload: {
        idempotencyKey: "packless-money-order",
        customerId: "customer-demo",
        reference: "MO-1",
        faceAmount: "0.01",
        feeAmount: "0.00",
        payee: "Ann Payee",
        serial: "MO-100",
      },
    }));
  });

  it("still clears a cheque and settles an obligation that were posted under a pack", async () => {
    await pool.query(
      `UPDATE legal_entities
          SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    const tellerCookie = await cookie();
    const cashed = await app.inject({
      method: "POST",
      url: "/api/ledger/cheques",
      cookies: tellerCookie,
      payload: {
        idempotencyKey: "held-cheque",
        customerId: "customer-demo",
        chequeNumber: "2002",
        maker: "Demo Customer",
        chequeType: "personal",
        typeLabel: "Personal",
        currency: "CAD",
        faceAmount: "100.00",
        feeAmount: "0.00",
        holdDays: 0,
      },
    });
    expect(cashed.statusCode).toBe(201);
    const sent = await app.inject({
      method: "POST",
      url: "/api/ledger/remittances/send",
      cookies: tellerCookie,
      payload: {
        idempotencyKey: "open-send",
        customerId: "customer-demo",
        reference: "RM-OPEN",
        principalAmount: "100.00",
        feeAmount: "0.00",
        payoutCurrency: "USD",
        payoutAmount: "70.00",
        corridor: "US",
        partner: "Corridor partner",
        beneficiaryName: "Ann Beneficiary",
        purpose: "Family support",
        sourceOfFunds: "Salary",
      },
    });
    expect(sent.statusCode).toBe(201);
    const chequeId = cashed.json().cheque.chequeId as string;
    const cashingId = cashed.json().transactionId as string;
    const obligationId = sent.json().obligationId as string;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP TABLE IF EXISTS tmp_tx");
      await client.query("DROP TABLE IF EXISTS tmp_chq");
      await client.query(
        `CREATE TEMP TABLE tmp_tx AS SELECT * FROM ledger_transactions WHERE transaction_id=$1`,
        [cashingId],
      );
      await client.query(
        `UPDATE tmp_tx
            SET transaction_id='tx-unstamped', transaction_ref='CD-UNSTAMPED-1',
                jurisdiction_pack_id=NULL, jurisdiction_pack_version=NULL`,
      );
      await client.query(`INSERT INTO ledger_transactions SELECT * FROM tmp_tx`);
      await client.query(
        `CREATE TEMP TABLE tmp_chq AS SELECT * FROM ledger_cheques WHERE cheque_id=$1`,
        [chequeId],
      );
      /* A different number. This row is an older cashing the fixture
         invents so it can be cleared after the pack is gone. It is not
         a second live copy of cheque 2002. */
      await client.query(
        `UPDATE tmp_chq
            SET cheque_id='chq-unstamped', cheque_ref='CHQ-UNSTAMPED',
                cheque_number='2002-unstamped',
                cashing_transaction_id='tx-unstamped', settlement_transaction_id=NULL`,
      );
      await client.query(`INSERT INTO ledger_cheques SELECT * FROM tmp_chq`);
      await client.query("DROP TABLE tmp_tx");
      await client.query("DROP TABLE tmp_chq");
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    await pool.query(
      `UPDATE legal_entities
          SET home_currency='RSD', jurisdiction_pack_id=NULL, jurisdiction_pack_version=NULL
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );

    const cleared = await app.inject({
      method: "POST",
      url: `/api/ledger/cheques/${chequeId}/clearance`,
      cookies: tellerCookie,
      payload: { idempotencyKey: "clear-held", reference: "BANK-1" },
    });
    expect(cleared.statusCode).toBe(201);
    const owner = await cookie("j.masri");
    const settled = await app.inject({
      method: "POST",
      url: `/api/ledger/obligations/${obligationId}/settlement`,
      cookies: owner,
      payload: {
        idempotencyKey: "settle-open",
        amountHome: sent.json().carryingAmountHome,
      },
    });
    expect(settled.statusCode).toBe(201);
    const unstamped = await app.inject({
      method: "POST",
      url: "/api/ledger/cheques/chq-unstamped/clearance",
      cookies: tellerCookie,
      payload: { idempotencyKey: "clear-unstamped" },
    });
    expect(unstamped.statusCode).toBe(201);

    const stamp = async (transactionId: string) =>
      (await pool.query(
        `SELECT btrim(jurisdiction_pack_id) AS jurisdiction_pack_id, jurisdiction_pack_version
           FROM ledger_transactions WHERE transaction_id=$1`,
        [transactionId],
      )).rows[0];
    expect(await stamp(cleared.json().transactionId)).toMatchObject({
      jurisdiction_pack_id: "pack-ca-v1",
      jurisdiction_pack_version: 1,
    });
    expect(await stamp(settled.json().transactionId)).toMatchObject({
      jurisdiction_pack_id: "pack-ca-v1",
      jurisdiction_pack_version: 1,
    });
    const bare = await stamp(unstamped.json().transactionId);
    expect(bare.jurisdiction_pack_id).toBeNull();
    expect(bare.jurisdiction_pack_version).toBeNull();
  });

  it("still voids a deal, a cheque and an obligation posted before the pack was removed", async () => {
    await pool.query(
      `UPDATE legal_entities
          SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    const tellerCookie = await cookie();
    const posted = await service.post(teller, {
      idempotencyKey: "void-exchange",
      customerId: "customer-demo",
      from: "CAD",
      to: "USD",
      inputAmount: "100.00",
      feeCad: "0.00",
      purpose: "Travel",
      sourceOfFunds: "Cash",
    });
    const cashed = await app.inject({
      method: "POST",
      url: "/api/ledger/cheques",
      cookies: tellerCookie,
      payload: {
        idempotencyKey: "void-cheque",
        customerId: "customer-demo",
        chequeNumber: "3003",
        maker: "Demo Customer",
        chequeType: "personal",
        typeLabel: "Personal",
        currency: "CAD",
        faceAmount: "40.00",
        feeAmount: "0.00",
        holdDays: 0,
      },
    });
    expect(cashed.statusCode).toBe(201);
    const sent = await app.inject({
      method: "POST",
      url: "/api/ledger/remittances/send",
      cookies: tellerCookie,
      payload: {
        idempotencyKey: "void-send",
        customerId: "customer-demo",
        reference: "RM-VOID",
        principalAmount: "25.00",
        feeAmount: "0.00",
        payoutCurrency: "USD",
        payoutAmount: "15.00",
        corridor: "US",
        partner: "Corridor partner",
        beneficiaryName: "Ann Beneficiary",
        purpose: "Family support",
        sourceOfFunds: "Salary",
      },
    });
    expect(sent.statusCode).toBe(201);
    await pool.query(
      `UPDATE legal_entities
          SET home_currency='RSD', jurisdiction_pack_id=NULL, jurisdiction_pack_version=NULL
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    const owner = await cookie("j.masri");
    const exchangeVoid = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${posted.transactionId}/reversal`,
      cookies: owner,
      payload: { idempotencyKey: "void-exchange-now", reason: "Wrong customer" },
    });
    expect(exchangeVoid.statusCode).toBe(201);
    const chequeVoid = await app.inject({
      method: "POST",
      url: `/api/ledger/cheques/${cashed.json().cheque.chequeId}/reversal`,
      cookies: owner,
      payload: { idempotencyKey: "void-cheque-now", reason: "Wrong cheque" },
    });
    expect(chequeVoid.statusCode).toBe(201);
    const obligationVoid = await app.inject({
      method: "POST",
      url: `/api/ledger/obligation-deals/${sent.json().transactionId}/reversal`,
      cookies: owner,
      payload: { idempotencyKey: "void-send-now", reason: "Wrong beneficiary" },
    });
    expect(obligationVoid.statusCode).toBe(201);
  });

  it("still moves till cash and vault cash", async () => {
    const owner = await cookie("j.masri");
    const till = await app.inject({
      method: "POST",
      url: "/api/ledger/till-movements",
      cookies: owner,
      payload: {
        idempotencyKey: "packless-till",
        direction: "in",
        currency: "RSD",
        amount: "10.00",
        counterpartyType: "bank",
        counterpartyRef: "bank-1",
        reason: "Delivery from the bank",
      },
    });
    expect(till.statusCode).toBe(201);
    const opened = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/opening-position",
      cookies: owner,
      payload: { balances: { RSD: "100.00" } },
    });
    expect(opened.statusCode).toBe(201);
    const received = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/receipts",
      cookies: owner,
      payload: {
        idempotencyKey: "packless-vault",
        direction: "in",
        currency: "RSD",
        amount: "10.00",
        counterpartyType: "bank",
        counterpartyRef: "bank-1",
        reason: "Delivery into the safe",
      },
    });
    expect(received.statusCode).toBe(201);
  });
});
