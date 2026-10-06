/* pack-ca-v2 against a real PostgreSQL ledger.
   Version 1 is left as it was seeded. The new lines, the 24-hour
   identity rule, the foreign-exchange ticket, and the beneficiary
   record are proved here, in Decimal, on amounts that land on either
   side of the legal line. */
import pg from "pg";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";
import { ObligationService } from "../src/ledger/obligations.js";
import { requireIdentification, type LedgerActor } from "../src/ledger/service.js";
import { ThresholdService } from "../src/ledger/threshold-control.js";
import type { IdentificationDeal } from "../src/ledger/canada-rules.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const TENANT = "tnt-ca2";
const V1 = "le-ca2-v1";
const V2 = "le-ca2-v2";
const LOOSE = "le-ca2-loose";
const TIGHT = "le-ca2-tight";
const OPTIN = "le-ca2-optin";
const STAY = "le-ca2-stay";
const GB = "le-ca2-gb";

let handle: DbHandle;
let pool: pg.Pool;
let obligations: ObligationService;
let thresholds: ThresholdService;

const scopeOf = (entityId: string) => ({
  tenantId: TENANT,
  legalEntityId: entityId,
  branchId: "br-ca2",
  workspaceId: "ws-ca2",
  tillId: "till-ca2",
});

function actor(entityId: string, role: LedgerActor["role"], userId: string): LedgerActor {
  const scope = scopeOf(entityId);
  return {
    userId,
    ...scope,
    role,
    authorizedBranchIds: [scope.branchId],
  };
}

async function entity(
  id: string,
  packId: string,
  version: number,
  idThreshold: string | null = null,
) {
  await pool.query(
    `INSERT INTO legal_entities
       (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version, id_threshold)
     VALUES ($1, $2, $1, 'CAD', $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET jurisdiction_pack_id = EXCLUDED.jurisdiction_pack_id,
           jurisdiction_pack_version = EXCLUDED.jurisdiction_pack_version,
           id_threshold = EXCLUDED.id_threshold,
           home_currency = 'CAD'`,
    [id, TENANT, packId, version, idThreshold],
  );
}

async function book(entityId: string) {
  const scope = scopeOf(entityId);
  const teller = actor(entityId, "teller", `ca2-teller-${entityId}`);
  await pool.query(
    `INSERT INTO ledger_principals
       (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids)
     VALUES ($1,$2,$3,$4,$5,$6,'teller',$7)
     ON CONFLICT DO NOTHING`,
    [teller.userId, scope.tenantId, scope.legalEntityId, scope.branchId, scope.workspaceId, scope.tillId, JSON.stringify(["br-ca2"])],
  );
  await pool.query(
    `INSERT INTO ledger_customers
       (customer_id, tenant_id, legal_entity_id, branch_id, workspace_id, name, risk, id_status)
     VALUES
       ($1,$2,$3,$4,$5,'Ada Conductor','normal','verified'),
       ($6,$2,$3,$4,$5,'Walk-in','normal','missing')
     ON CONFLICT DO NOTHING`,
    [`ca2-known-${entityId}`, scope.tenantId, scope.legalEntityId, scope.branchId, scope.workspaceId, `ca2-unknown-${entityId}`],
  );
  await pool.query(
    `INSERT INTO ledger_rates
       (tenant_id, legal_entity_id, branch_id, workspace_id, currency, units_per_cad)
     VALUES ($1,$2,$3,$4,'CAD',1)
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.legalEntityId, scope.branchId, scope.workspaceId],
  );
  await pool.query(
    `INSERT INTO ledger_till_balances
       (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
     VALUES ($1,$2,$3,$4,$5,'CAD',25000)
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.legalEntityId, scope.branchId, scope.workspaceId, scope.tillId],
  );
  await pool.query(
    `INSERT INTO ledger_till_sessions
       (session_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
        session_number, business_date, status, opened_by, opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,current_date,'open',$7,now())
     ON CONFLICT DO NOTHING`,
    [`sess-${entityId}`, scope.tenantId, scope.legalEntityId, scope.branchId, scope.workspaceId, scope.tillId, teller.userId],
  );
  return teller;
}

async function withTx<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function gate(
  entityId: string,
  amount: string,
  verified: boolean,
  deal: IdentificationDeal,
) {
  return withTx(async (client) => {
    const pack = await resolvePack(client, entityId);
    return requireIdentification(
      client,
      actor(entityId, "teller", `ca2-gate-${entityId}`),
      pack,
      new Decimal(amount),
      verified ? "verified" : "missing",
      deal,
    );
  });
}

const fx = (customerId: string | null, onBehalfOf: string | null = null): IdentificationDeal => ({
  kind: "exchange",
  cash: true,
  cashIn: true,
  customerId,
  onBehalfOf,
});

async function priorCash(
  client: pg.PoolClient,
  entityId: string,
  id: string,
  opts: {
    amount: string;
    customerId: string;
    onBehalfOf?: string | null;
    dealKind?: string;
    fromCurrency?: string;
    homeCurrency?: string | null;
    cashInHome?: string | null;
    beneficiary?: string | null;
    reversed?: boolean;
  },
) {
  const scope = scopeOf(entityId);
  const third = opts.onBehalfOf?.trim() || null;
  await client.query(
    `INSERT INTO ledger_transactions
       (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
        customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
        fee_cad, spread_cad, purpose, source_of_funds, posted_at,
        deal_kind, received_instrument, disbursed_instrument,
        cash_in_home, home_currency, third_party, third_party_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'USD',$11,$12,1,0,0,'Travel','Salary',now(),
             $13,'cash','cash',$14,$15,$16,$17)`,
    [
      id,
      `ref-${id}`,
      scope.tenantId,
      scope.legalEntityId,
      scope.branchId,
      scope.workspaceId,
      scope.tillId,
      opts.customerId,
      "ca2-actor",
      opts.fromCurrency ?? "CAD",
      opts.amount,
      opts.amount,
      opts.dealKind ?? "exchange",
      opts.cashInHome === undefined ? opts.amount : opts.cashInHome,
      opts.homeCurrency === undefined ? "CAD" : opts.homeCurrency,
      !!third,
      third,
    ],
  );
  if (opts.beneficiary) {
    await client.query(
      `INSERT INTO ledger_obligations
         (obligation_id, obligation_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
          customer_id, transaction_id, kind, direction, counterparty, reference,
          face_currency, face_amount, home_currency, carrying_amount_home, status, opened_at, created_by,
          beneficiary_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'remittance_payable','payable','Partner',$2,
               'PHP',1,'CAD',$10,'open',now(),'ca2-actor',$11)`,
      [
        `obl-${id}`,
        `OR-${id}`,
        scope.tenantId,
        scope.legalEntityId,
        scope.branchId,
        scope.workspaceId,
        scope.tillId,
        opts.customerId,
        id,
        opts.amount,
        opts.beneficiary,
      ],
    );
  }
  if (opts.reversed) {
    await client.query(
      `INSERT INTO ledger_reversals (reversal_id, transaction_id, actor_id, reason, posted_at)
       VALUES ($1,$2,'ca2-actor','mistaken',now())`,
      [`rev-${id}`, id],
    );
  }
}

postgres("Canada pack version 2 on PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    obligations = new ObligationService(pool);
    thresholds = new ThresholdService(pool);
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING",
      [TENANT],
    );
    await entity(V1, "pack-ca-v1", 1);
    await entity(V2, "pack-ca-v2", 2);
    await entity(LOOSE, "pack-ca-v2", 2, "5000.00");
    await entity(TIGHT, "pack-ca-v2", 2, "500.00");
    await entity(OPTIN, "pack-ca-v1", 1, "2500.00");
    await entity(STAY, "pack-ca-v1", 1);
    await entity(GB, "pack-gb-v1", 1);
    await book(V1);
    await book(V2);
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("leaves version 1 untouched and installs version 2 beside it", async () => {
    const v1Lines = await pool.query(
      `SELECT deal_kind, threshold::text
         FROM jurisdiction_id_thresholds
        WHERE pack_id = 'pack-ca-v1'
        ORDER BY deal_kind`,
    );
    expect(v1Lines.rows.map((row) => row.deal_kind)).toEqual([
      "eft",
      "fx",
      "remittance",
      "virtual_currency",
    ]);
    for (const row of v1Lines.rows) {
      expect(new Decimal(row.threshold).eq(3000)).toBe(true);
    }

    const v1Reports = await pool.query(
      `SELECT code, deadline_value, deadline_unit, aggregate_all_amounts, kind
         FROM jurisdiction_reports
        WHERE pack_id = 'pack-ca-v1'
        ORDER BY code`,
    );
    expect(v1Reports.rows.map((row) => row.code)).toEqual(["EFTR", "LCTR", "STR"]);
    for (const row of v1Reports.rows) {
      expect(row.deadline_value).toBeNull();
      expect(row.deadline_unit).toBeNull();
      expect(row.aggregate_all_amounts).toBe(false);
    }

    const v2Lines = await pool.query(
      `SELECT deal_kind, threshold::text
         FROM jurisdiction_id_thresholds
        WHERE pack_id = 'pack-ca-v2'
        ORDER BY deal_kind`,
    );
    const line = Object.fromEntries(
      v2Lines.rows.map((row) => [row.deal_kind, row.threshold]),
    );
    expect(new Decimal(line.fx).eq(3000)).toBe(true);
    expect(new Decimal(line.money_order).eq(3000)).toBe(true);
    expect(new Decimal(line.remittance).eq(1000)).toBe(true);
    expect(new Decimal(line.eft).eq(1000)).toBe(true);
    expect(new Decimal(line.virtual_currency).eq(1000)).toBe(true);

    const v2Reports = await pool.query(
      `SELECT code, kind, deadline_value, deadline_unit, aggregate_all_amounts,
              aggregation_axes, direction, cash_only, format_rules
         FROM jurisdiction_reports
        WHERE pack_id = 'pack-ca-v2'`,
    );
    const report = Object.fromEntries(v2Reports.rows.map((row) => [row.code, row]));
    expect(report.LCTR).toMatchObject({
      kind: "large_cash",
      deadline_value: 15,
      deadline_unit: "calendar_days",
      aggregate_all_amounts: true,
      direction: "in",
      cash_only: true,
    });
    expect(report.LCTR.aggregation_axes).toEqual([
      "conductor",
      "on_behalf_of",
      "beneficiary",
    ]);
    expect(report.EFTR).toMatchObject({
      kind: "wire",
      deadline_value: 5,
      deadline_unit: "business_days",
      aggregate_all_amounts: false,
      aggregation_axes: null,
    });
    expect(report.LVCTR).toMatchObject({
      kind: "virtual_currency",
      deadline_value: 5,
      deadline_unit: "business_days",
      aggregate_all_amounts: true,
    });
    expect(report.STR.deadline_unit).toBeNull();
    expect(report.STR.format_rules).toEqual({ deadline_label: "as soon as practicable" });
    expect(report.LPEPR).toMatchObject({
      kind: "other",
      deadline_unit: "immediately",
    });
    expect(v2Reports.rows.map((row) => row.code)).not.toContain("SANCTIONS-STOP");

    const stayed = await pool.query(
      "SELECT jurisdiction_pack_id, jurisdiction_pack_version FROM legal_entities WHERE id = $1",
      [STAY],
    );
    expect(stayed.rows[0]).toMatchObject({
      jurisdiction_pack_id: "pack-ca-v1",
      jurisdiction_pack_version: 1,
    });
  });

  it("lets only an owner move a version 1 Canada desk, and leaves the saved line", async () => {
    const owner = actor(OPTIN, "administrator", "ca2-owner");
    await pool.query(
      `INSERT INTO ledger_principals
         (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids)
       VALUES ($1,$2,$3,$4,$5,$6,'administrator',$7)`,
      [owner.userId, owner.tenantId, owner.legalEntityId, owner.branchId, owner.workspaceId, owner.tillId, JSON.stringify(["br-ca2"])],
    );
    const moved = await thresholds.optInCanadaV2(owner);
    expect(moved.packId).toBe("pack-ca-v2");
    const row = await pool.query(
      `SELECT jurisdiction_pack_id, jurisdiction_pack_version, id_threshold::text AS id_threshold
         FROM legal_entities WHERE id = $1`,
      [OPTIN],
    );
    expect(row.rows[0].jurisdiction_pack_id).toBe("pack-ca-v2");
    expect(row.rows[0].jurisdiction_pack_version).toBe(2);
    expect(new Decimal(row.rows[0].id_threshold).eq(2500)).toBe(true);
    const audit = await pool.query(
      "SELECT action FROM ledger_audit_events WHERE legal_entity_id = $1 AND action = 'compliance.pack.opt_in'",
      [OPTIN],
    );
    expect(audit.rowCount).toBe(1);
    const still = await pool.query(
      "SELECT jurisdiction_pack_id FROM legal_entities WHERE id = $1",
      [STAY],
    );
    expect(still.rows[0].jurisdiction_pack_id).toBe("pack-ca-v1");
    await expect(thresholds.optInCanadaV2(owner)).rejects.toMatchObject({
      code: "PACK_OPT_IN_REFUSED",
    });
    const british = actor(GB, "administrator", "ca2-owner-gb");
    await pool.query(
      `INSERT INTO ledger_principals
         (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids)
       VALUES ($1,$2,$3,$4,$5,$6,'administrator',$7)`,
      [british.userId, british.tenantId, british.legalEntityId, british.branchId, british.workspaceId, british.tillId, JSON.stringify(["br-ca2"])],
    );
    await expect(thresholds.optInCanadaV2(british)).rejects.toMatchObject({
      code: "PACK_OPT_IN_REFUSED",
    });
  });

  it("identifies each kind of deal at its own line", async () => {
    const unknown = `ca2-unknown-${V2}`;
    await expect(gate(V2, "999.00", false, { kind: "remittance_send", cash: true, cashIn: true, customerId: unknown })).resolves.toBeTruthy();
    await expect(gate(V2, "1000.00", false, { kind: "remittance_send", cash: true, cashIn: true, customerId: unknown })).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await expect(gate(V2, "2999.00", false, fx(unknown))).resolves.toBeTruthy();
    await expect(gate(V2, "3000.00", false, fx(unknown))).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await expect(gate(V2, "2999.00", false, { kind: "money_order", cash: true, cashIn: true, customerId: unknown })).resolves.toBeTruthy();
    await expect(gate(V2, "3000.00", false, { kind: "money_order", cash: true, cashIn: true, customerId: unknown })).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    /* A cheque is the foreign-exchange line, and it is not cash received. */
    await expect(gate(V2, "2999.00", false, { kind: "cheque_cashing", cash: true, cashIn: false, customerId: unknown })).resolves.toBeTruthy();
    await expect(gate(V2, "3000.00", false, { kind: "cheque_cashing", cash: true, cashIn: false, customerId: unknown })).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    /* Version 1 still has one line, so a CAD 1,000 remittance is under it. */
    await expect(gate(V1, "1000.00", false, { kind: "remittance_send", cash: true, cashIn: true, customerId: `ca2-unknown-${V1}` })).resolves.toBeTruthy();
    await expect(gate(V1, "3000.00", false, { kind: "remittance_send", cash: true, cashIn: true, customerId: `ca2-unknown-${V1}` })).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
  });

  it("does not let a looser desk number lift the CAD 1,000 lines", async () => {
    const unknown = "ca2-loose-walkin";
    await expect(gate(LOOSE, "4000.00", false, fx(unknown))).resolves.toBeTruthy();
    await expect(gate(LOOSE, "5000.00", false, fx(unknown))).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await expect(gate(LOOSE, "1000.00", false, { kind: "remittance_send", cash: true, cashIn: true, customerId: unknown })).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await expect(gate(TIGHT, "500.00", false, fx(unknown))).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await expect(gate(TIGHT, "499.00", false, { kind: "remittance_send", cash: true, cashIn: true, customerId: unknown })).resolves.toBeTruthy();
    await expect(gate(TIGHT, "500.00", false, { kind: "remittance_send", cash: true, cashIn: true, customerId: unknown })).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
  });

  it("requires identity when the 24-hour cash total reaches the report line", async () => {
    const customer = "ca2-window-customer";
    const blocked = async (amount: string, deal: IdentificationDeal, seed: (client: pg.PoolClient) => Promise<void>) => {
      await expect(
        withTx(async (client) => {
          await seed(client);
          const pack = await resolvePack(client, V2);
          return requireIdentification(
            client,
            actor(V2, "teller", "ca2-window"),
            pack,
            new Decimal(amount),
            "missing",
            deal,
          );
        }),
      ).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    };

    /* Under the foreign-exchange line on its own. The earlier receipt
       puts the window over CAD 10,000, so identity is required. */
    await expect(gate(V2, "2500.00", false, fx(customer))).resolves.toBeTruthy();
    await blocked("2500.00", fx(customer), (client) =>
      priorCash(client, V2, "ca2-prior-8k", { amount: "8000.00", customerId: customer }),
    );
    /* A receipt already at the line stays inside the total. Leaving it
       out would hide the CAD 1,000 that follows it. */
    await blocked("1000.00", fx(customer), (client) =>
      priorCash(client, V2, "ca2-prior-12k", { amount: "12000.00", customerId: customer }),
    );
    /* A reversed receipt is not cash the desk still holds. */
    await expect(
      withTx(async (client) => {
        await priorCash(client, V2, "ca2-prior-reversed", {
          amount: "8000.00",
          customerId: customer,
          reversed: true,
        });
        const pack = await resolvePack(client, V2);
        return requireIdentification(client, actor(V2, "teller", "ca2-window"), pack, new Decimal("2500.00"), "missing", fx(customer));
      }),
    ).resolves.toBeTruthy();
    /* A foreign receipt with no home figure is not priced here. */
    await expect(
      withTx(async (client) => {
        await priorCash(client, V2, "ca2-prior-foreign", {
          amount: "8000.00",
          customerId: customer,
          fromCurrency: "USD",
          cashInHome: null,
        });
        const pack = await resolvePack(client, V2);
        return requireIdentification(client, actor(V2, "teller", "ca2-window"), pack, new Decimal("2500.00"), "missing", fx(customer));
      }),
    ).resolves.toBeTruthy();
    /* An older home-currency exchange that never wrote cash_in_home
       still counts, because the input needs no conversion. */
    await blocked("2500.00", fx(customer), (client) =>
      priorCash(client, V2, "ca2-prior-fallback", {
        amount: "8000.00",
        customerId: customer,
        cashInHome: null,
      }),
    );
    /* Cheque clearance is not a deal the customer did. */
    await expect(
      withTx(async (client) => {
        await priorCash(client, V2, "ca2-prior-clearing", {
          amount: "8000.00",
          customerId: customer,
          dealKind: "cheque_clearing",
        });
        const pack = await resolvePack(client, V2);
        return requireIdentification(client, actor(V2, "teller", "ca2-window"), pack, new Decimal("2500.00"), "missing", fx(customer));
      }),
    ).resolves.toBeTruthy();
    /* A cashed cheque is not cash received, so it does not complete an
       LCTR even when earlier cash is already in the window. */
    await expect(
      withTx(async (client) => {
        await priorCash(client, V2, "ca2-prior-for-cheque", { amount: "8000.00", customerId: customer });
        const pack = await resolvePack(client, V2);
        return requireIdentification(
          client,
          actor(V2, "teller", "ca2-window"),
          pack,
          new Decimal("2500.00"),
          "missing",
          { kind: "cheque_cashing", cash: true, cashIn: false, customerId: customer },
        );
      }),
    ).resolves.toBeTruthy();
  });

  it("adds the on-behalf-of axis and the beneficiary axis, and does not mix them", async () => {
    await expect(
      withTx(async (client) => {
        for (let n = 0; n < 4; n += 1) {
          await priorCash(client, V2, `ca2-behalf-${n}`, {
            amount: "2000.00",
            customerId: `ca2-other-${n}`,
            onBehalfOf: "Alex Patron",
          });
        }
        const pack = await resolvePack(client, V2);
        return requireIdentification(
          client,
          actor(V2, "teller", "ca2-window"),
          pack,
          new Decimal("2000.00"),
          "missing",
          fx("ca2-fifth", "Alex Patron"),
        );
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });

    /* Three earlier receipts leave the window at CAD 8,000. */
    await expect(
      withTx(async (client) => {
        for (let n = 0; n < 3; n += 1) {
          await priorCash(client, V2, `ca2-behalf-under-${n}`, {
            amount: "2000.00",
            customerId: `ca2-under-${n}`,
            onBehalfOf: "Alex Patron",
          });
        }
        const pack = await resolvePack(client, V2);
        return requireIdentification(
          client,
          actor(V2, "teller", "ca2-window"),
          pack,
          new Decimal("2000.00"),
          "missing",
          fx("ca2-fourth", "Alex Patron"),
        );
      }),
    ).resolves.toBeTruthy();

    await expect(
      withTx(async (client) => {
        await priorCash(client, V2, "ca2-benefit", {
          amount: "9600.00",
          customerId: "ca2-sender",
          beneficiary: "Pat Payee",
        });
        const pack = await resolvePack(client, V2);
        return requireIdentification(
          client,
          actor(V2, "teller", "ca2-window"),
          pack,
          new Decimal("500.00"),
          "missing",
          {
            kind: "remittance_send",
            cash: true,
            cashIn: true,
            customerId: "ca2-another-sender",
            beneficiaryName: "Pat Payee",
          },
        );
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
  });

  it("asks for the foreign-exchange ticket at the line, even when the document is verified", async () => {
    const known = `ca2-known-${V2}`;
    await expect(gate(V2, "3000.00", true, fx(known))).rejects.toMatchObject({ code: "FX_TICKET" });
    await expect(gate(V2, "2999.00", true, fx(known))).resolves.toBeTruthy();
    /* The document is still the first refusal. The ticket is not reached. */
    await expect(gate(V2, "3000.00", false, fx(known))).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });

    await pool.query(
      `INSERT INTO desk_clients
         (client_id, tenant_id, legal_entity_id, display_name, address_line, occupation, date_of_birth)
       VALUES ('cli-ca2', $1, $2, 'Ada Conductor', '14 Elm Street', 'Teacher', '1984-03-02')
       ON CONFLICT DO NOTHING`,
      [TENANT, V2],
    );
    await pool.query(
      "UPDATE ledger_customers SET client_id = 'cli-ca2' WHERE customer_id = $1",
      [known],
    );
    await expect(gate(V2, "3000.00", true, fx(known))).resolves.toBeTruthy();
  });

  it("stores the beneficiary on a version 2 remittance at the line, and not before", async () => {
    const teller = actor(V2, "teller", `ca2-teller-${V2}`);
    const known = `ca2-known-${V2}`;
    const base = {
      customerId: known,
      payoutCurrency: "PHP",
      payoutAmount: "1000.00",
      corridor: "PH",
      partner: "Cebuana",
      purpose: "Family support",
      sourceOfFunds: "Salary",
    };
    await expect(
      obligations.remittanceSend(teller, {
        ...base,
        idempotencyKey: "ca2-send-gap",
        reference: "TR-CA2-GAP",
        principalAmount: "1000.00",
        feeAmount: "0.00",
        beneficiaryName: "Maria Carter",
      }),
    ).rejects.toMatchObject({ code: "BENEFICIARY_RECORD" });

    const posted = await obligations.remittanceSend(teller, {
      ...base,
      idempotencyKey: "ca2-send-ok",
      reference: "TR-CA2-OK",
      principalAmount: "1000.00",
      feeAmount: "0.00",
      beneficiaryName: "Maria Carter",
      beneficiaryAddress: "12 Rizal Street, Manila",
    });
    const stored = await pool.query(
      `SELECT beneficiary_name, beneficiary_address
         FROM ledger_obligations WHERE transaction_id = $1`,
      [(posted as { transactionId: string }).transactionId],
    );
    expect(stored.rows[0]).toEqual({
      beneficiary_name: "Maria Carter",
      beneficiary_address: "12 Rizal Street, Manila",
    });

    const under = await obligations.remittanceSend(teller, {
      ...base,
      idempotencyKey: "ca2-send-under",
      reference: "TR-CA2-UNDER",
      principalAmount: "999.00",
      feeAmount: "0.00",
      beneficiaryName: "Maria Carter",
    });
    const omitted = await pool.query(
      "SELECT beneficiary_address FROM ledger_obligations WHERE transaction_id = $1",
      [(under as { transactionId: string }).transactionId],
    );
    expect(omitted.rows[0].beneficiary_address).toBeNull();

    /* Version 1 has one line and no beneficiary rule. A verified
       customer at CAD 3,500 still posts without an address. */
    const v1 = actor(V1, "teller", `ca2-teller-${V1}`);
    const old = await obligations.remittanceSend(v1, {
      ...base,
      customerId: `ca2-known-${V1}`,
      idempotencyKey: "ca2-send-v1",
      reference: "TR-CA2-V1",
      principalAmount: "3500.00",
      feeAmount: "0.00",
      beneficiaryName: "Maria Carter",
    });
    expect((old as { transactionId: string }).transactionId).toEqual(expect.any(String));

    await expect(
      obligations.remittanceReceive(teller, {
        idempotencyKey: "ca2-recv-gap",
        customerId: known,
        reference: "TR-CA2-RCV",
        sentCurrency: "PHP",
        sentAmount: "4000.00",
        payoutAmount: "1000.00",
        feeAmount: "0.00",
        corridor: "PH",
        partner: "Cebuana",
        purpose: "Family support",
        sourceOfFunds: "Family abroad",
      }),
    ).rejects.toMatchObject({ code: "BENEFICIARY_RECORD" });

    const received = await obligations.remittanceReceive(teller, {
      idempotencyKey: "ca2-recv-ok",
      customerId: known,
      reference: "TR-CA2-RCVOK",
      sentCurrency: "PHP",
      sentAmount: "4000.00",
      payoutAmount: "1000.00",
      feeAmount: "0.00",
      corridor: "PH",
      partner: "Cebuana",
      purpose: "Family support",
      sourceOfFunds: "Family abroad",
      beneficiaryName: "Ada Conductor",
      beneficiaryAddress: "14 Elm Street, Toronto",
    });
    const recvRow = await pool.query(
      "SELECT beneficiary_name, beneficiary_address FROM ledger_obligations WHERE transaction_id = $1",
      [(received as { transactionId: string }).transactionId],
    );
    expect(recvRow.rows[0]).toEqual({
      beneficiary_name: "Ada Conductor",
      beneficiary_address: "14 Elm Street, Toronto",
    });
  });
});
