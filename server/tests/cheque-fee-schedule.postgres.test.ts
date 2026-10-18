/* The cheque fee is the price of cash the desk has not collected.
   A teller cannot set the schedule, and cannot book a fee under it.
   The type has to be one of the six ids. A desk with no schedule
   does not cash a cheque at 0. A schedule set to 0% still books 0. */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { CHEQUE_FEE_REFUSAL, CHEQUE_FEE_SCHEDULE_KEY, DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";
import { CHEQUE_FEE_ABOVE, CHEQUE_FEE_BELOW, CHEQUE_FEE_SETUP, CHEQUE_TYPE_UNKNOWN } from "../src/ledger/cheques.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
/* The book another file left behind. This file cashes CAD, then puts that book back. */
let priorBook: { home: string; pack: string | null; version: number | null } | null = null;
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

function cash(who: Record<string, string>, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST", url: "/api/ledger/cheques", cookies: who,
    payload: {
      idempotencyKey: `fee-${Math.random().toString(36).slice(2)}`,
      customerId: "customer-demo", chequeNumber: "2001", maker: "Maple Payroll",
      draweeBank: "Scotiabank", chequeType: "payroll", typeLabel: "Payroll", currency: "CAD",
      faceAmount: "1000.25", feeAmount: "0.00", holdDays: 1, endorsed: true,
      ...extra,
    },
  });
}

async function tillAmount() {
  const till = await pool.query("SELECT available_amount FROM ledger_till_balances WHERE till_id='till-01'");
  return String(till.rows[0].available_amount);
}

async function chequeCount() {
  const rows = await pool.query("SELECT count(*)::int AS n FROM ledger_cheques");
  return Number(rows.rows[0].n);
}

async function holdTill(staffId: string) {
  await pool.query("UPDATE ledger_till_sessions SET opened_by=$1 WHERE session_id='fee-session'", [`${DEMO.tenantId}:${staffId}`]);
}

async function pinCadBook() {
  if (!priorBook) {
    const row = await pool.query(
      "SELECT btrim(home_currency) AS home, btrim(jurisdiction_pack_id) AS pack, jurisdiction_pack_version AS version FROM legal_entities WHERE id=$1",
      [DEMO.legalEntityId],
    );
    const found = row.rows[0];
    priorBook = {
      home: found?.home ?? "CAD",
      pack: found?.pack ?? null,
      version: found?.version == null ? null : Number(found.version),
    };
  }
  await pool.query(
    "UPDATE legal_entities SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1 WHERE id=$1",
    [DEMO.legalEntityId],
  );
}

async function restoreBook() {
  if (!priorBook) return;
  const prior = priorBook;
  priorBook = null;
  await pool.query(
    "UPDATE legal_entities SET home_currency=$2, jurisdiction_pack_id=$3, jurisdiction_pack_version=$4 WHERE id=$1",
    [DEMO.legalEntityId, prior.home, prior.pack, prior.version],
  );
}

async function desk() {
  await pinCadBook();
  await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_sessions,ledger_till_balances,ledger_customers,ledger_audit_events,audit_events CASCADE");
  await pool.query("INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 1)", [DEMO.tenantId, JSON.stringify({ [CHEQUE_FEE_SCHEDULE_KEY]: JSON.stringify(DEFAULT_CHEQUE_SCHEDULE) })]);
  await pool.query("INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status) VALUES ('customer-demo',$1,$2,$3,$4,'Jakob Miller','Normal','verified')", scope.slice(0, 4));
  await pool.query("INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,'CAD',5000)", scope);
  await pool.query("INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at) VALUES ('fee-session',$1,$2,$3,$4,$5,1,DATE '2026-06-18','open',$6,now())", [...scope, `${DEMO.tenantId}:m.costa`]);
}

postgres("cheque fee schedule is owner or manager", () => {
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
        staffId, name: role, role: "auditor", authorizedBranchIds: [DEMO.branchId], passwordHash,
      }).onConflictDoNothing();
      await handle.db.insert(schema.platformUsers).values({ email: staffId, name: role, role, status: "active", addedBy: "test" }).onConflictDoNothing();
      await handle.db.update(schema.staffUsers).set({ role: "auditor" }).where(eq(schema.staffUsers.staffId, staffId));
    }
    /* The shop owner is also the platform owner. That row must not
       turn their fee save into the teller's refusal. */
    await handle.db.insert(schema.platformUsers).values({
      email: "j.masri", name: "J. Masri", role: "owner", status: "active", addedBy: "test",
    }).onConflictDoNothing();
    await handle.db.insert(schema.staffUsers).values({
      id: `${DEMO.tenantId}:fee.compliance`, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId,
      staffId: "fee.compliance", name: "Compliance", role: "compliance_officer", authorizedBranchIds: [DEMO.branchId], passwordHash,
    }).onConflictDoNothing();
    pool = new pg.Pool({ connectionString: url });
    app = await buildApp(handle.db);
    for (const staffId of ["j.masri", "r.haddad", "a.singh", "m.costa", "s.iqbal", "fee.compliance", ...platformRoles.map((role) => `fee.${role}`)]) sessions[staffId] = await sign(staffId);
  });

  afterEach(async () => {
    await restoreBook();
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

  it("refuses a teller, a senior teller, and an auditor before validation", async () => {
    await desk();
    const before = await storedSchedule();
    for (const staffId of ["m.costa", "a.singh", "fee.auditor"]) {
      const res = await put(session(staffId), payroll(0, 0), "no");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "permission_denied", detail: CHEQUE_FEE_REFUSAL });
      expect(await storedSchedule()).toBe(before);
    }
    const audit = await pool.query("SELECT action FROM audit_events WHERE action='settings.cheque_fee_refused'");
    expect(audit.rowCount).toBe(3);
    const changed = await pool.query("SELECT action FROM audit_events WHERE action='settings.cheque_fee_changed'");
    expect(changed.rowCount).toBe(0);
  });

  it("lets a manager save 0% and records who changed which price", async () => {
    await desk();
    const saved = await put(session("r.haddad"), payroll(0, 0));
    expect(saved.statusCode).toBe(200);
    expect(await storedSchedule()).toContain('"feePct":0');
    const row = await pool.query("SELECT detail, at FROM audit_events WHERE action='settings.cheque_fee_changed'");
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].at).toBeTruthy();
    const detail = row.rows[0].detail;
    expect(detail).toMatchObject({ staffId: "r.haddad", name: "R. Haddad", role: "branch_manager" });
    const payrollBefore = detail.before.find((item: { id: string }) => item.id === "payroll");
    const payrollAfter = detail.after.find((item: { id: string }) => item.id === "payroll");
    expect(payrollBefore).toMatchObject({ feePct: 2, feeMin: 5, holdDays: 1 });
    expect(payrollAfter).toMatchObject({ feePct: 0, feeMin: 0, holdDays: 1 });
    const booked = await cash(session("m.costa"), { feeAmount: "0.00", chequeNumber: "zero-pct" });
    expect(booked.statusCode, booked.body).toBe(201);
    expect(booked.json().cheque.feeAmount).toBe("0.00");
    const below = await pool.query("SELECT action FROM audit_events WHERE action='cheque.fee_below_schedule'");
    expect(below.rowCount).toBe(0);
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
    const changes = await pool.query("SELECT action FROM audit_events WHERE action='settings.cheque_fee_changed'");
    expect(changes.rowCount).toBe(1);
  });

  it("still lets a teller save a state that does not change the schedule", async () => {
    await desk();
    const before = await storedSchedule();
    const res = await put(session("m.costa"), { [CHEQUE_FEE_SCHEDULE_KEY]: before, cdos_settings: { deskName: "Yorkville" } });
    expect(res.statusCode).toBe(200);
    expect(await storedSchedule()).toBe(before);
  });

  it("refuses a fee under the schedule, and books 20.01 when the quote meets it", async () => {
    await desk();
    const tillBefore = await tillAmount();
    const refused = await put(session("m.costa"), payroll(0, 0));
    expect(refused.statusCode).toBe(403);
    const under = await cash(session("m.costa"), { feeAmount: "0.00" });
    expect(under.statusCode, under.body).toBe(422);
    expect(CHEQUE_FEE_BELOW).toBe("Nothing was cashed. That fee is below the schedule for this cheque.");
    expect(under.json()).toMatchObject({ code: "INVALID_REQUEST", message: CHEQUE_FEE_BELOW });
    expect(await chequeCount()).toBe(0);
    expect(await tillAmount()).toBe(tillBefore);
    const half = await cash(session("m.costa"), { feeAmount: "20.00", chequeNumber: "half" });
    expect(half.statusCode, half.body).toBe(422);
    expect(half.json().message).toBe(CHEQUE_FEE_BELOW);
    const booked = await cash(session("m.costa"), { feeAmount: "20.01" });
    expect(booked.statusCode, booked.body).toBe(201);
    expect(booked.json().cheque.feeAmount).toBe("20.01");
    expect(booked.json().cheque.netAmount).toBe("980.24");
    expect(await tillAmount()).toBe("4019.76");
    expect((await pool.query("SELECT action FROM audit_events WHERE action LIKE 'cheque.fee_%schedule'")).rowCount).toBe(0);
    const over = await cash(session("m.costa"), { feeAmount: "25.00", chequeNumber: "2002" });
    expect(over.statusCode, over.body).toBe(422);
    expect(CHEQUE_FEE_ABOVE).toBe("Nothing was cashed. That fee is above the schedule for this cheque.");
    expect(over.json().message).toBe(CHEQUE_FEE_ABOVE);
    expect(await chequeCount()).toBe(1);
    expect((await pool.query("SELECT action FROM audit_events WHERE action='cheque.fee_above_schedule'")).rowCount).toBe(0);
  });

  it("lets the owner or a manager book 0 and audits that booking", async () => {
    await desk();
    for (const [staffId, role, actor] of [
      ["j.masri", "administrator", `${DEMO.tenantId}:j.masri`],
      ["r.haddad", "branch_manager", `${DEMO.tenantId}:r.haddad`],
    ] as const) {
      await holdTill(staffId);
      const booked = await cash(session(staffId), { feeAmount: "0.00", chequeNumber: staffId });
      expect(booked.statusCode, booked.body).toBe(201);
      expect(booked.json().cheque.feeAmount).toBe("0.00");
      const row = await pool.query(
        "SELECT actor_id, detail FROM audit_events WHERE action='cheque.fee_below_schedule' AND actor_id=$1",
        [actor],
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].detail).toMatchObject({
        role, chequeType: "payroll", scheduleFee: "20.01", bookedFee: "0.00", face: "1000.25",
      });
      const high = await cash(session(staffId), { feeAmount: "25.00", chequeNumber: `${staffId}-high` });
      expect(high.statusCode, high.body).toBe(201);
      expect(high.json().cheque.feeAmount).toBe("25.00");
      const above = await pool.query(
        "SELECT actor_id, detail FROM audit_events WHERE action='cheque.fee_above_schedule' AND actor_id=$1",
        [actor],
      );
      expect(above.rowCount).toBe(1);
      expect(above.rows[0].detail).toMatchObject({
        role, chequeType: "payroll", scheduleFee: "20.01", bookedFee: "25.00", face: "1000.25",
      });
    }
  });

  it("refuses a cheque type that is not one of the six ids", async () => {
    await desk();
    const tillBefore = await tillAmount();
    for (const chequeType of ["PAYROLL", "Payroll", "pay roll", "other", "cheque", "payroll\u200b"]) {
      const res = await cash(session("m.costa"), { chequeType, feeAmount: "0.00" });
      expect(res.statusCode, `${chequeType} ${res.body}`).toBe(422);
      expect(CHEQUE_TYPE_UNKNOWN).toBe("Nothing was cashed. That cheque type isn't on this desk's fee list. Pick another type.");
      expect(res.json().message).toBe(CHEQUE_TYPE_UNKNOWN);
    }
    expect(await chequeCount()).toBe(0);
    expect(await tillAmount()).toBe(tillBefore);
  });

  it("refuses to cash a cheque when the desk has no schedule", async () => {
    await desk();
    await pool.query("UPDATE tenant_state SET state = state - $2 WHERE tenant_id=$1", [DEMO.tenantId, CHEQUE_FEE_SCHEDULE_KEY]);
    const missing = await cash(session("m.costa"), { feeAmount: "20.01" });
    expect(missing.statusCode, missing.body).toBe(422);
    expect(CHEQUE_FEE_SETUP).toBe("Nothing was cashed. This desk has no cheque fees yet. The owner or a manager sets them in Cheques, Fee schedule.");
    expect(missing.json().message).toBe(CHEQUE_FEE_SETUP);
    expect(await chequeCount()).toBe(0);
    await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    await holdTill("j.masri");
    const gone = await cash(session("j.masri"), { feeAmount: "0.00" });
    expect(gone.statusCode, gone.body).toBe(422);
    expect(gone.json().message).toBe(CHEQUE_FEE_SETUP);
    expect(await chequeCount()).toBe(0);
  });

  it("refuses a stored schedule that does not name the type", async () => {
    await desk();
    const rows = DEFAULT_CHEQUE_SCHEDULE.filter((row) => row.id !== "payroll");
    await pool.query(
      "UPDATE tenant_state SET state = jsonb_set(state, $2::text[], to_jsonb($3::text), true) WHERE tenant_id=$1",
      [DEMO.tenantId, `{${CHEQUE_FEE_SCHEDULE_KEY}}`, JSON.stringify(rows)],
    );
    const res = await cash(session("m.costa"), { feeAmount: "20.01" });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toBe(CHEQUE_FEE_SETUP);
    expect(await chequeCount()).toBe(0);
  });

  it("refuses off-schedule fees for every role except the owner and a branch manager", async () => {
    await desk();
    const tillBefore = await tillAmount();
    /* Trainee is stored as a teller. s.iqbal is that teller. */
    const refused = [
      ["m.costa", 422],
      ["a.singh", 422],
      ["s.iqbal", 422],
      ["fee.auditor", 403],
      ["fee.compliance", 403],
    ] as const;
    for (const [staffId, status] of refused) {
      await holdTill(staffId);
      for (const feeAmount of ["0.00", "900.00"]) {
        const res = await cash(session(staffId), { feeAmount, chequeNumber: `${staffId}-${feeAmount}` });
        expect(res.statusCode, `${staffId} ${feeAmount} ${res.body}`).toBe(status);
        if (status === 422) expect(res.json().message).toBe(feeAmount === "0.00" ? CHEQUE_FEE_BELOW : CHEQUE_FEE_ABOVE);
      }
    }
    expect(await chequeCount()).toBe(0);
    expect(await tillAmount()).toBe(tillBefore);
    expect((await pool.query("SELECT action FROM audit_events WHERE action LIKE 'cheque.fee_%schedule'")).rowCount).toBe(0);
  });

  it("does not tell a teller a fee save worked when nothing was stored", async () => {
    await desk();
    await pool.query("UPDATE tenant_state SET state = state - $2 WHERE tenant_id=$1", [DEMO.tenantId, CHEQUE_FEE_SCHEDULE_KEY]);
    const version = Number((await pool.query("SELECT version FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId])).rows[0].version);
    const res = await put(session("m.costa"), { [CHEQUE_FEE_SCHEDULE_KEY]: JSON.stringify(DEFAULT_CHEQUE_SCHEDULE) }, version);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toEqual({ error: "permission_denied", detail: CHEQUE_FEE_REFUSAL });
    expect(await storedSchedule()).toBe(null);
    expect((await pool.query("SELECT action FROM audit_events WHERE action='settings.cheque_fee_refused'")).rowCount).toBe(1);
    const same = await put(session("m.costa"), { cdos_settings: { deskName: "Yorkville" } }, version);
    expect(same.statusCode, same.body).toBe(200);
    expect(await storedSchedule()).toBe(null);
  });

  it("answers a stale fee tab with 409 before it calls the fee a refusal", async () => {
    await desk();
    const before = await storedSchedule();
    const stale = await put(session("m.costa"), payroll(0, 0), 0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("state_conflict");
    expect(await storedSchedule()).toBe(before);
    const refused = await pool.query("SELECT action FROM audit_events WHERE action='settings.cheque_fee_refused'");
    expect(refused.rowCount).toBe(0);
  });

  it("does not let a teller's copy replace a fee the owner just saved", async () => {
    for (let n = 0; n < 15; n++) {
      await desk();
      const original = await storedSchedule();
      const [ownerRes, tellerRes] = await Promise.all([
        put(session("j.masri"), payroll(7, 5), 1),
        put(session("m.costa"), { [CHEQUE_FEE_SCHEDULE_KEY]: original, cdos_settings: { deskName: "Yorkville" } }, 1),
      ]);
      expect([200, 409]).toContain(ownerRes.statusCode);
      expect([200, 409]).toContain(tellerRes.statusCode);
      expect([ownerRes.statusCode, tellerRes.statusCode]).not.toEqual([200, 200]);
      const stored = JSON.parse((await storedSchedule()) ?? "[]") as { id: string; feePct: number }[];
      const feePct = stored.find((row) => row.id === "payroll")?.feePct;
      if (ownerRes.statusCode === 200) expect(feePct).toBe(7);
      expect(feePct === 2 || feePct === 7).toBe(true);
    }
  });

  it("does not let an unversioned save replace a fee", async () => {
    await desk();
    const before = await storedSchedule();
    const bare = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: session("j.masri"), payload: { state: payroll(1, 1) } });
    expect(bare.statusCode).toBe(409);
    expect(await storedSchedule()).toBe(before);
    expect((await pool.query("SELECT action FROM audit_events WHERE action='settings.cheque_fee_refused'")).rowCount).toBe(0);
    expect((await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: session("m.costa"), payload: { state: { [CHEQUE_FEE_SCHEDULE_KEY]: before, cdos_settings: { deskName: "York" } } } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: session("m.costa"), payload: { state: payroll(0, 0) } })).statusCode).toBe(409);
    expect(await storedSchedule()).toBe(before);
    for (let n = 0; n < 15; n++) {
      await desk();
      const original = await storedSchedule();
      const [ownerRes] = await Promise.all([
        put(session("j.masri"), payroll(7, 5), 1),
        app.inject({ method: "PUT", url: "/api/tenant/state", cookies: session("m.costa"), payload: { state: { [CHEQUE_FEE_SCHEDULE_KEY]: original, cdos_settings: { n } } } }),
      ]);
      const feePct = (JSON.parse((await storedSchedule()) ?? "[]") as { id: string; feePct: number }[]).find((row) => row.id === "payroll")?.feePct;
      if (ownerRes.statusCode === 200) expect(feePct).toBe(7);
    }
    expect((await pool.query("SELECT action FROM audit_events WHERE action='settings.cheque_fee_refused'")).rowCount).toBe(0);
  });
});
