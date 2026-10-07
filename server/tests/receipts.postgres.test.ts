import pg from "pg";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { useEmailSenderForTests, type EmailStatus } from "../src/email.js";
import { RECEIPT_CLOSING } from "../src/receipts/closing.js";
import { resetReceiptEmailLimitsForTests } from "../src/receipts/send.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;
const sent: { from: string; html?: string; replyTo?: string; attachments?: { filename: string; contentBase64: string }[] }[] = [];

const post = {
  idempotencyKey: "receipt-post",
  customerId: "customer-demo",
  from: "CAD",
  to: "USD",
  inputAmount: "1000.00",
  feeCad: "4.00",
  purpose: "Travel",
  sourceOfFunds: "Cash",
};

async function cookie(staffId = "a.singh") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

async function ensureDeskRows() {
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, 'York FX') ON CONFLICT (id) DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities (id, tenant_id, name, msb_number)
     VALUES ($1, $2, 'York Currency Exchange Inc.', 'M12345678')
     ON CONFLICT (id) DO NOTHING`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
}

async function resetLedger() {
  await pool.query(
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES ($1||':a.singh',$1,$2,$3,$4,$5,'teller','["br-yorkville"]')`,
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
      ($1,$2,$3,$4,'USD',0.731)`,
    scope.slice(0, 4),
  );
  for (const [currency, value] of [["CAD", 25000], ["USD", 12000]] as const) {
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, value],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-receipt',$1,$2,$3,$4,$5,1,current_date,'open',$1||':a.singh',now())`,
    scope,
  );
}

postgres("receipt amounts and email against PostgreSQL", () => {
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
    useEmailSenderForTests(null);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    sent.length = 0;
    resetReceiptEmailLimitsForTests();
    useEmailSenderForTests(async (input) => {
      sent.push(input);
      return "sent";
    });
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "receipts@example.com";
    await handle.db.update(schema.staffUsers).set({ role: "teller" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
    await handle.db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, "receipt.email"));
    await resetLedger();
    await ensureDeskRows();
    await pool.query("DELETE FROM desk_clients WHERE tenant_id=$1", [DEMO.tenantId]);
  });

  async function postDeal() {
    const cookies = await cookie();
    const posted = await app.inject({ method: "POST", url: "/api/ledger/exchanges", cookies, payload: post });
    expect(posted.statusCode).toBe(201);
    return { cookies, body: posted.json() };
  }

  it("prints the same amounts the ledger stored", async () => {
    const { cookies, body } = await postDeal();
    const receipt = await app.inject({
      method: "GET",
      url: `/api/ledger/transactions/${body.transactionId}/receipt`,
      cookies,
    });
    expect(receipt.statusCode).toBe(200);
    const json = receipt.json();
    expect(json.lines.join(" ")).toContain("Demo Customer");
    const stored = await pool.query(
      "SELECT input_amount, output_amount, rate, fee_cad, from_currency, to_currency FROM ledger_transactions WHERE transaction_id=$1",
      [body.transactionId],
    );
    const row = stored.rows[0];
    expect(json.inputAmount).toBe(String(row.input_amount));
    expect(json.outputAmount).toBe(String(row.output_amount));
    expect(json.feeCad).toBe(String(row.fee_cad));
    expect(json.rate).toBe(String(row.rate));
    expect(new Decimal(json.inputAmount).eq(row.input_amount)).toBe(true);
    expect(new Decimal(json.outputAmount).eq(row.output_amount)).toBe(true);
    expect(new Decimal(json.rate).eq(row.rate)).toBe(true);
    expect(new Decimal(json.feeCad).eq(row.fee_cad)).toBe(true);
    expect(json.fromCurrency).toBe(String(row.from_currency).trim());
    expect(json.toCurrency).toBe(String(row.to_currency).trim());
  });

  it("emails the receipt through the injected sender and records the audit", async () => {
    const { cookies, body } = await postDeal();
    await pool.query(
      `INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
       VALUES ('cli-receipt',$1,$2,'Demo Customer')`,
      [DEMO.tenantId, DEMO.legalEntityId],
    );
    await pool.query(
      "UPDATE ledger_customers SET client_id='cli-receipt' WHERE customer_id='customer-demo'",
    );
    const mailed = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${body.transactionId}/receipt/email`,
      cookies,
      payload: { to: "customer@example.com", saveToClient: true },
    });
    expect(mailed.statusCode).toBe(200);
    expect(mailed.json().saved).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toContain("York Currency Exchange Inc.");
    expect(sent[0]!.from).toContain("receipts@example.com");
    expect(sent[0]!.html).toContain(RECEIPT_CLOSING);
    expect(sent[0]!.html).toContain("1000.00");
    const pdf = Buffer.from(sent[0]!.attachments![0]!.contentBase64, "base64");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("1000.00");
    const saved = await pool.query("SELECT email FROM desk_clients WHERE client_id='cli-receipt'");
    expect(saved.rows[0].email).toBe("customer@example.com");
    const audit = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "receipt.email"));
    expect(audit[0]?.detail).toMatchObject({ to: "customer@example.com", status: "sent", transactionRef: body.transactionRef });
  });

  it("leaves the deal and the client email alone when sending fails", async () => {
    useEmailSenderForTests(async () => "failed" satisfies EmailStatus);
    const { cookies, body } = await postDeal();
    await pool.query(
      `INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name, email)
       VALUES ('cli-fail',$1,$2,'Demo Customer','kept@example.com')`,
      [DEMO.tenantId, DEMO.legalEntityId],
    );
    await pool.query("UPDATE ledger_customers SET client_id='cli-fail' WHERE customer_id='customer-demo'");
    const before = await pool.query("SELECT input_amount::text AS input_amount FROM ledger_transactions WHERE transaction_id=$1", [body.transactionId]);
    const mailed = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${body.transactionId}/receipt/email`,
      cookies,
      payload: { to: "new@example.com", saveToClient: true },
    });
    expect(mailed.statusCode).toBe(502);
    expect(mailed.json().message).toContain("unchanged");
    const after = await pool.query("SELECT input_amount::text AS input_amount FROM ledger_transactions WHERE transaction_id=$1", [body.transactionId]);
    expect(after.rows[0].input_amount).toBe(before.rows[0].input_amount);
    const email = await pool.query("SELECT email FROM desk_clients WHERE client_id='cli-fail'");
    expect(email.rows[0].email).toBe("kept@example.com");
  });

  it("refuses when email is not configured and rate limits the rest", async () => {
    const { cookies, body } = await postDeal();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    const hidden = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${body.transactionId}/receipt/email`,
      cookies,
      payload: { to: "customer@example.com" },
    });
    expect(hidden.statusCode).toBe(503);
    expect(hidden.json().error).toBe("email_not_configured");
    expect(sent).toHaveLength(0);

    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "receipts@example.com";
    for (let n = 0; n < 5; n++) {
      const ok = await app.inject({
        method: "POST",
        url: `/api/ledger/transactions/${body.transactionId}/receipt/email`,
        cookies,
        payload: { to: "limit@example.com" },
      });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${body.transactionId}/receipt/email`,
      cookies,
      payload: { to: "limit@example.com" },
    });
    expect(blocked.statusCode).toBe(429);
  });
});
