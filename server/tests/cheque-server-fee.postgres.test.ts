/* The cheque fee is the server's figure.
   A browser fee of 0, with no saved schedule, is not the price.
   A type the schedule does not name is refused and nothing is written.
   A fee the browser tampers is not the price.
   A schedule that sets 0% on purpose still books 0.00. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { CHEQUE_FEE_SCHEDULE_KEY, DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
const UNPRICED = "Nothing was cashed. This cheque type has no fee on the schedule. The owner or a manager can add it in Cheques, Fee schedule.";

function stored(schedule: unknown) {
  return JSON.stringify({ [CHEQUE_FEE_SCHEDULE_KEY]: typeof schedule === "string" ? schedule : JSON.stringify(schedule) });
}

async function sign() {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "m.costa", password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { cdos_session: res.cookies.find((item) => item.name === "cdos_session")!.value };
}

async function desk(schedule: unknown) {
  await pool.query(
    `UPDATE legal_entities
        SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1
      WHERE id=$1 AND tenant_id=$2`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_sessions,ledger_till_balances,ledger_customers CASCADE");
  if (schedule !== undefined) {
    await pool.query(
      "INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 1)",
      [DEMO.tenantId, stored(schedule)],
    );
  }
  await pool.query(
    "INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status) VALUES ('customer-demo',$1,$2,$3,$4,'Jakob Miller','Normal','verified')",
    scope.slice(0, 4),
  );
  const { fileCurrentPhotoId } = await import("./current-photo-id.js");
  await fileCurrentPhotoId(pool, "customer-demo");
  await pool.query(
    "INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,'CAD',5000)",
    scope,
  );
  await pool.query(
    "INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at) VALUES ('server-fee-session',$1,$2,$3,$4,$5,1,DATE '2026-06-18','open',$6,now())",
    [...scope, `${DEMO.tenantId}:m.costa`],
  );
}

function cash(
  cookies: Record<string, string>,
  body: { key: string; chequeType: string; faceAmount: string; feeAmount: string; typeLabel?: string },
) {
  return app.inject({
    method: "POST",
    url: "/api/ledger/cheques",
    cookies,
    payload: {
      idempotencyKey: body.key,
      customerId: "customer-demo",
      chequeNumber: body.key,
      maker: "Northbridge Imports Ltd.",
      draweeBank: "RBC Royal Bank",
      chequeType: body.chequeType,
      typeLabel: body.typeLabel ?? "Business",
      currency: "CAD",
      faceAmount: body.faceAmount,
      feeAmount: body.feeAmount,
      holdDays: 0,
      endorsed: true,
    },
  });
}

async function booked() {
  const rows = await pool.query("SELECT fee_amount, net_amount FROM ledger_cheques");
  const till = await pool.query("SELECT available_amount FROM ledger_till_balances WHERE till_id='till-01' AND currency='CAD'");
  return { cheques: rows.rowCount ?? 0, fee: rows.rows[0]?.fee_amount ?? null, till: till.rows[0].available_amount as string };
}

postgres("the server prices the cheque fee", () => {
  let teller: Record<string, string>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    await seed(handle.db);
    pool = new pg.Pool({ connectionString: url });
    app = await buildApp(handle.db);
    teller = await sign();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
      await pool.end();
    }
    if (app) await app.close();
    if (handle) await handle.close();
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  it("prices a business cheque from the default schedule when none is saved and the browser sends 0", async () => {
    await desk(undefined);
    const cashed = await cash(teller, { key: "fee-none-zero", chequeType: "business", faceAmount: "1000.00", feeAmount: "0.00" });
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("30.00");
    expect(cashed.json().cheque.netAmount).toBe("970.00");
    const book = await booked();
    expect(book).toMatchObject({ cheques: 1, fee: "30.00", till: "4030.00" });
  });

  it("prices from the default schedule when the saved schedule is an empty list and the browser sends 0", async () => {
    await desk("[]");
    const cashed = await cash(teller, { key: "fee-empty-zero", chequeType: "business", faceAmount: "1000.00", feeAmount: "0.00" });
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("30.00");
    expect(cashed.json().cheque.netAmount).toBe("970.00");
  });

  it("refuses a cheque type the schedule does not name, and writes nothing", async () => {
    await desk(undefined);
    const refused = await cash(teller, { key: "fee-unknown-type", chequeType: "foo", faceAmount: "500.00", feeAmount: "0.00", typeLabel: "Foo" });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toEqual({ code: "CHEQUE_TYPE_UNPRICED", message: UNPRICED });
    const book = await booked();
    expect(book.cheques).toBe(0);
    expect(book.till).toBe("5000.00");
    const tx = await pool.query("SELECT count(*)::int AS n FROM ledger_transactions");
    expect(tx.rows[0].n).toBe(0);
  });

  it("refuses a type a saved schedule left out, and does not use the default price", async () => {
    await desk(DEFAULT_CHEQUE_SCHEDULE.filter((row) => row.id === "payroll"));
    const refused = await cash(teller, { key: "fee-omitted-type", chequeType: "business", faceAmount: "1000.00", feeAmount: "0.00" });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toEqual({ code: "CHEQUE_TYPE_UNPRICED", message: UNPRICED });
    const book = await booked();
    expect(book.cheques).toBe(0);
    expect(book.till).toBe("5000.00");
  });

  it("books the schedule fee when the browser sends a different fee", async () => {
    await desk(undefined);
    const cashed = await cash(teller, { key: "fee-tampered", chequeType: "business", faceAmount: "1000.00", feeAmount: "1.00" });
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("30.00");
    expect(cashed.json().cheque.netAmount).toBe("970.00");
    const book = await booked();
    expect(book).toMatchObject({ cheques: 1, fee: "30.00", till: "4030.00" });
    const feeLine = await pool.query("SELECT amount_cad FROM ledger_journal_entries WHERE account_code='revenue:cheque_fee'");
    expect(feeLine.rows).toEqual([{ amount_cad: "30.00" }]);
  });

  it("books 0.00 when the saved schedule sets that type to 0%", async () => {
    const zero = DEFAULT_CHEQUE_SCHEDULE.map((row) => row.id === "payroll" ? { ...row, feePct: 0, feeMin: 0 } : row);
    await desk(zero);
    const cashed = await cash(teller, {
      key: "fee-explicit-zero",
      chequeType: "payroll",
      faceAmount: "200.00",
      feeAmount: "15.00",
      typeLabel: "Payroll",
    });
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("0.00");
    expect(cashed.json().cheque.netAmount).toBe("200.00");
    const book = await booked();
    expect(book).toMatchObject({ cheques: 1, fee: "0.00", till: "4800.00" });
  });
});
