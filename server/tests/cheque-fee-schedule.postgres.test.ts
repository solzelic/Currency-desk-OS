/* The cheque fee is the price of cash the desk has not collected.
   A teller who can save payroll at 0% cashes the next cheque for nothing.
   Real Postgres: the write is refused, the schedule stays, the cheque pays the old fee. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { CHEQUE_FEE_REFUSAL, CHEQUE_FEE_SCHEDULE_KEY, DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
const PASS = "yorkville";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
const sessions: Record<string, Record<string, string>> = {};
const platformRoles = ["auditor", "support", "billing", "security", "privacy", "owner"] as const;

const payroll = (feePct: number, feeMin: number) => ({
  [CHEQUE_FEE_SCHEDULE_KEY]: JSON.stringify(DEFAULT_CHEQUE_SCHEDULE.map((row) => row.id === "payroll" ? { ...row, feePct, feeMin } : row)),
});

async function sign(staffId: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: PASS, tenantId: DEMO.tenantId } });
  expect(res.statusCode, res.body).toBe(200);
  return { cdos_session: res.cookies.find((item) => item.name === "cdos_session")!.value };
}

function session(staffId: string): Record<string, string> {
  const found = sessions[staffId];
  if (!found) throw new Error(`No session for ${staffId}`);
  return found;
}

function put(who: Record<string, string>, state: Record<string, unknown>, version: unknown = 1) {
  return app.inject({ method: "PUT", url: "/api/tenant/state", cookies: who, payload: { state, version } });
}

async function storedSchedule(): Promise<string | null> {
  const row = await pool.query("SELECT state->$2 AS schedule FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId, CHEQUE_FEE_SCHEDULE_KEY]);
  const value = row.rows[0]?.schedule;
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function desk() {
  await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_sessions,ledger_till_balances,ledger_customers,ledger_audit_events,audit_events CASCADE");
  await pool.query("INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 1)", [DEMO.tenantId, JSON.stringify({ [CHEQUE_FEE_SCHEDULE_KEY]: JSON.stringify(DEFAULT_CHEQUE_SCHEDULE) })]);
  await pool.query("INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status) VALUES ('customer-demo',$1,$2,$3,$4,'Jakob Miller','Normal','verified')", scope.slice(0, 4));
  await pool.query("INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,'CAD',5000)", scope);
  await pool.query("INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at) VALUES ('fee-session',$1,$2,$3,$4,$5,1,DATE '2026-06-18','open',$6,now())", [...scope, `${DEMO.tenantId}:m.costa`]);
}

postgres("cheque fee schedule is owner only", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    process.env.SEED_PASSWORD = PASS;
    handle = await createDb();
    await seed(handle.db);
    const passwordHash = await hashPassword(PASS);
    for (const role of platformRoles) {
      const staffId = `fee.${role}`;
      await handle.db.insert(schema.staffUsers).values({
        id: `${DEMO.tenantId}:${staffId}`, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId,
        staffId, name: role, role: "administrator", authorizedBranchIds: [DEMO.branchId], passwordHash,
      }).onConflictDoNothing();
      await handle.db.insert(schema.platformUsers).values({ email: staffId, name: role, role, status: "active", addedBy: "test" }).onConflictDoNothing();
    }
    pool = new pg.Pool({ connectionString: url });
    app = await buildApp(handle.db);
    for (const staffId of ["j.masri", "r.haddad", "m.costa", ...platformRoles.map((role) => `fee.${role}`)]) sessions[staffId] = await sign(staffId);
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

  it("refuses a teller and a manager, and leaves the schedule", async () => {
    await desk();
    const before = await storedSchedule();
    for (const staffId of ["m.costa", "r.haddad"]) {
      const res = await put(session(staffId), payroll(0, 0), "no");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "permission_denied", detail: CHEQUE_FEE_REFUSAL });
      expect(await storedSchedule()).toBe(before);
    }
    const audit = await pool.query("SELECT action FROM audit_events WHERE action='settings.owner_only_refused'");
    expect(audit.rowCount).toBe(2);
  });

  it("lets the owner save, and refuses every platform role", async () => {
    await desk();
    const before = await storedSchedule();
    for (const role of platformRoles) {
      const res = await put(session(`fee.${role}`), payroll(0, 0));
      expect({ status: res.statusCode, detail: res.json().detail }).toEqual({ status: 403, detail: CHEQUE_FEE_REFUSAL });
      expect(await storedSchedule()).toBe(before);
    }
    const saved = await put(session("j.masri"), payroll(0, 0));
    expect(saved.statusCode).toBe(200);
    expect(await storedSchedule()).toContain('"feePct":0');
    const bad = await put(session("j.masri"), payroll(9, 9), "no");
    expect(bad.statusCode).toBe(400);
    expect(await storedSchedule()).toContain('"feePct":0');
  });

  it("still lets a teller save a state that does not change the schedule", async () => {
    await desk();
    const before = await storedSchedule();
    const res = await put(session("m.costa"), { [CHEQUE_FEE_SCHEDULE_KEY]: before, cdos_settings: { deskName: "Yorkville" } });
    expect(res.statusCode).toBe(200);
    expect(await storedSchedule()).toBe(before);
  });

  it("cashes the next cheque at the old fee after a refused write", async () => {
    await desk();
    const refused = await put(session("m.costa"), payroll(0, 0));
    expect(refused.statusCode).toBe(403);
    const cashed = await app.inject({
      method: "POST", url: "/api/ledger/cheques", cookies: session("m.costa"),
      payload: {
        idempotencyKey: "fee-old", customerId: "customer-demo", chequeNumber: "2001", maker: "Maple Payroll",
        draweeBank: "Scotiabank", chequeType: "payroll", typeLabel: "Payroll", currency: "CAD",
        faceAmount: "200.00", feeAmount: "0.00", holdDays: 1, endorsed: true,
      },
    });
    expect(cashed.statusCode, cashed.body).toBe(201);
    expect(cashed.json().cheque.feeAmount).toBe("5.00");
    const till = await pool.query("SELECT available_amount FROM ledger_till_balances WHERE till_id='till-01'");
    expect(till.rows[0].available_amount).toBe("4805.00");
  });
});
