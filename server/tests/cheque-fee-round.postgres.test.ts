/* Payroll 1,000.25 at 2% books 20.01 through the cheque route.
   A figure the helper cannot read is refused, and nothing is booked at 0.00.
   A fee percent of 2.12345 cannot be saved. A percent already stored with
   more than 2 digits after the point rounds half up to 2 and still books. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { fileTypedId } from "./typed-id.js";
import { CHEQUE_FEE_SCHEDULE_KEY, DEFAULT_CHEQUE_SCHEDULE, FEE_MAX_PLACES, FEE_MIN_PLACES, FEE_PERCENT_PLACES } from "../src/routes/tenantState.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
const PASS = "yorkville";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];

const schedule = (feePct: unknown, feeMin: unknown) =>
  JSON.stringify(DEFAULT_CHEQUE_SCHEDULE.map((row) => row.id === "payroll" ? { ...row, feePct, feeMin } : row));

async function desk(feePct: unknown = 2, feeMin: unknown = 5) {
  /* seed() does not overwrite an existing entity. A prior file can leave
     York FX on a GBP pack, and a CAD cheque is then refused as foreign.
     Each case restates the Canadian pack seed() creates, then its own
     schedule, customer, drawer, and session. */
  await pool.query(
    `UPDATE legal_entities
        SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1',
            jurisdiction_pack_version=1
      WHERE id=$1 AND tenant_id=$2`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_sessions,ledger_till_balances,ledger_customers CASCADE");
  await pool.query(
    "INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 1)",
    [DEMO.tenantId, JSON.stringify({ [CHEQUE_FEE_SCHEDULE_KEY]: schedule(feePct, feeMin) })],
  );
  await pool.query(
    "INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status) VALUES ('customer-demo',$1,$2,$3,$4,'Jakob Miller','Normal','verified')",
    scope.slice(0, 4),
  );
  await fileTypedId(pool, "customer-demo");
  await pool.query(
    "INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,'CAD',5000)",
    scope,
  );
  await pool.query(
    "INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at) VALUES ('round-session',$1,$2,$3,$4,$5,1,DATE '2026-06-18','open',$6,now())",
    [...scope, `${DEMO.tenantId}:m.costa`],
  );
}

async function sign(staffId: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: PASS, tenantId: DEMO.tenantId } });
  expect(res.statusCode, res.body).toBe(200);
  return { cdos_session: res.cookies.find((item) => item.name === "cdos_session")!.value };
}

function cash(cookies: Record<string, string>, faceAmount: string, key: string) {
  return app.inject({
    method: "POST",
    url: "/api/ledger/cheques",
    cookies,
    payload: {
      idempotencyKey: key,
      customerId: "customer-demo",
      chequeNumber: key,
      maker: "Maple Payroll",
      draweeBank: "Scotiabank",
      chequeType: "payroll",
      typeLabel: "Payroll",
      currency: "CAD",
      faceAmount,
      feeAmount: "0.00",
      holdDays: 1,
      endorsed: true,
    },
  });
}

postgres("cheque fee rounding on the route", () => {
  let teller: Record<string, string>;
  let owner: Record<string, string>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    process.env.SEED_PASSWORD = PASS;
    handle = await createDb();
    await seed(handle.db);
    pool = new pg.Pool({ connectionString: url });
    app = await buildApp(handle.db);
    teller = await sign("m.costa");
    owner = await sign("j.masri");
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
    delete process.env.SEED_PASSWORD;
  });

  it("books 20.01 for payroll 1,000.25 at 2%", async () => {
    await desk();
    const cashed = await cash(teller, "1000.25", "round-1000-25");
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("20.01");
    expect(cashed.json().cheque.netAmount).toBe("980.24");
    const row = await pool.query("SELECT fee_amount FROM ledger_cheques");
    expect(row.rows[0].fee_amount).toBe("20.01");
  });

  it("books 20.01 for a face of 1000.5 at 2%", async () => {
    await desk();
    const cashed = await cash(teller, "1000.5", "round-1000-5");
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("20.01");
    expect(cashed.json().cheque.netAmount).toBe("980.49");
  });

  it("refuses a figure the helper cannot read and books nothing at 0.00", async () => {
    await desk("nope", 5);
    const refused = await cash(teller, "1000.00", "round-unreadable");
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ code: "INVALID_REQUEST", message: "Nothing was cashed. The fee for this cheque type can't be read. The owner or a manager can fix it in Cheques, Fee schedule." });
    const booked = await pool.query("SELECT fee_amount FROM ledger_cheques");
    expect(booked.rowCount).toBe(0);
    const till = await pool.query("SELECT available_amount FROM ledger_till_balances WHERE till_id='till-01'");
    expect(till.rows[0].available_amount).toBe("5000.00");
  });

  async function savedSchedule() {
    const row = await pool.query("SELECT state->>$2 AS schedule FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId, CHEQUE_FEE_SCHEDULE_KEY]);
    return row.rows[0].schedule as string;
  }

  function putSchedule(body: string) {
    return app.inject({
      method: "PUT", url: "/api/tenant/state", cookies: owner,
      payload: { state: { [CHEQUE_FEE_SCHEDULE_KEY]: body }, version: 1 },
    });
  }

  it("refuses to save a fee percent of 2.12345", async () => {
    await desk();
    const before = await savedSchedule();
    const saved = await putSchedule(schedule(2.12345, 5));
    expect(saved.statusCode, saved.body).toBe(400);
    expect(saved.json()).toEqual({ error: "fee_places", field: "feePct", id: "payroll", detail: FEE_PERCENT_PLACES });
    expect(await savedSchedule()).toBe(before);
  });

  it("refuses to save a minimum of 4.005 and names feeMin", async () => {
    await desk();
    const before = await savedSchedule();
    const saved = await putSchedule(schedule(2, 4.005));
    expect(saved.statusCode, saved.body).toBe(400);
    expect(saved.json()).toEqual({ error: "fee_places", field: "feeMin", id: "payroll", detail: FEE_MIN_PLACES });
    expect(await savedSchedule()).toBe(before);
  });

  it("refuses to save a maximum of 4.005 and names feeMax", async () => {
    await desk();
    const before = await savedSchedule();
    const withMax = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE.map((row) => row.id === "payroll" ? { ...row, feeMax: 4.005 } : row));
    const saved = await putSchedule(withMax);
    expect(saved.statusCode, saved.body).toBe(400);
    expect(saved.json()).toEqual({ error: "fee_places", field: "feeMax", id: "payroll", detail: FEE_MAX_PLACES });
    expect(await savedSchedule()).toBe(before);
  });

  it("refuses a fee percent of 1e-7 and still saves 1e2", async () => {
    await desk();
    const before = await savedSchedule();
    const refused = await putSchedule(schedule(1e-7, 5));
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toEqual({ error: "fee_places", field: "feePct", id: "payroll", detail: FEE_PERCENT_PLACES });
    expect(await savedSchedule()).toBe(before);
    const saved = await putSchedule(schedule(1e2, 5));
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await savedSchedule()).toContain('"feePct":100');
  });

  it.each([
    ["feePct", -2, FEE_PERCENT_PLACES],
    ["feePct", "abc", FEE_PERCENT_PLACES],
    ["feePct", 1e21, FEE_PERCENT_PLACES],
    ["feePct", 1234567, FEE_PERCENT_PLACES],
    ["feePct", "2.5000000000000", FEE_PERCENT_PLACES],
    ["feePct", ".", FEE_PERCENT_PLACES],
    ["feeMin", -5, FEE_MIN_PLACES],
    ["feeMin", "1e3", FEE_MIN_PLACES],
    ["feeMin", 1e13, FEE_MIN_PLACES],
    ["feeMin", "4.", FEE_MIN_PLACES],
    ["feeMax", "x", FEE_MAX_PLACES],
  ] as const)("refuses a %s of %j on save", async (field, value, detail) => {
    await desk();
    const before = await savedSchedule();
    const body = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE.map((row) => row.id === "payroll" ? { ...row, [field]: value } : row));
    const saved = await putSchedule(body);
    expect(saved.statusCode, saved.body).toBe(400);
    expect(saved.json()).toEqual({ error: "fee_places", field, id: "payroll", detail });
    expect(await savedSchedule()).toBe(before);
  });

  it("refuses a stored minimum of 4. and cashes nothing", async () => {
    await desk(2, "4.");
    const refused = await cash(teller, "1000.25", "round-dot-min");
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ code: "INVALID_REQUEST", message: "Nothing was cashed. The fee for this cheque type can't be read. The owner or a manager can fix it in Cheques, Fee schedule." });
    const booked = await pool.query("SELECT fee_amount FROM ledger_cheques");
    expect(booked.rowCount).toBe(0);
  });

  it("rounds a stored percent of 2.125 half up to 2.13 and still books", async () => {
    await desk(2.125, 0);
    const cashed = await cash(teller, "1000.00", "round-stored-2125");
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("21.30");
  });
});
