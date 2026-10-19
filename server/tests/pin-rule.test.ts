/* A role or a permission is stored only when that person ranks strictly
   below the one who is signed in. Removing a row, putting a known
   person back, and the first copy of an empty list are the same edit.
   The owner is the signed-in administrator and is not locked out. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { PIN_ROW_REMOVAL } from "../src/state/pin-rule.js";

const REFUSAL = "Only someone senior to this person can change their role or permissions.";
let handle: DbHandle;
let app: FastifyInstance;
let owner: Record<string, string>;
let teller: Record<string, string>;
let manager: Record<string, string>;

const people = [
  { id: "e-owner", name: "J. Masri", code: "j.masri", role: "Owner", caps: { canVoid: false } },
  { id: "e-mgr", name: "R. Haddad", code: "r.haddad", role: "Manager", caps: { canVoid: true } },
  { id: "e-peer", name: "N. Owens", code: "n.owens", role: "Manager", caps: { canVoid: true } },
  { id: "e-tel", name: "M. Costa", code: "m.costa", role: "Cashier", caps: { canVoid: false } },
  { id: "e-iqbal", name: "S. Iqbal", code: "s.iqbal", role: "Cashier", caps: { canVoid: false } },
];
const clonePeople = () => people.map((p) => ({ ...p, caps: { ...p.caps } }));
const baseline = () => ({ cdos_rows_v1: [{ id: "kept" }], cdos_settings: { threshold: 10000, employees: clonePeople() } });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (!c) throw new Error("sign-in did not set a session cookie");
  return { cdos_session: c.value };
};
const login = async (staffId: string) => {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: "yorkville", tenantId: DEMO.tenantId } });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
};
const put = (cookies: Record<string, string>, state: Record<string, unknown>, version = 1) =>
  app.inject({ method: "PUT", url: "/api/tenant/state", cookies, payload: { state, version } });
const read = () => app.inject({ method: "GET", url: "/api/tenant/state", cookies: teller });
function desk(code: string, patch: Record<string, unknown>) {
  const employees = clonePeople().map((p) => (p.code === code ? { ...p, ...patch } : p));
  return { cdos_rows_v1: [{ id: "kept" }], cdos_settings: { threshold: 10000, employees } };
}
function listed(employees: Record<string, unknown>[]) {
  return { cdos_rows_v1: [{ id: "kept" }], cdos_settings: { threshold: 10000, employees } };
}
function without(code: string) {
  return listed(clonePeople().filter((p) => p.code !== code));
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  handle = await createDb();
  await seed(handle.db);
  await handle.db.insert(schema.staffUsers).values({
    id: `${DEMO.tenantId}:n.owens`, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId,
    branchId: DEMO.branchId, staffId: "n.owens", name: "N. Owens", role: "branch_manager",
    authorizedBranchIds: [DEMO.branchId], passwordHash: "not-a-sign-in",
  });
  app = await buildApp(handle.db);
  owner = await login("j.masri");
  teller = await login("s.iqbal");
  manager = await login("r.haddad");
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(async () => {
  await handle.db.delete(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
  const saved = await put(owner, baseline(), 0);
  expect(saved.statusCode, saved.body).toBe(200);
});

async function refused(cookies: Record<string, string>, state: Record<string, unknown>, detail = REFUSAL) {
  const denied = await put(cookies, state);
  expect(denied.statusCode, denied.body).toBe(403);
  expect(denied.json().detail).toBe(detail);
  expect((await read()).json().state).toEqual(baseline());
}

describe("who may change a role or permissions", () => {
  it("a teller cannot change someone's role", async () => {
    await refused(teller, desk("m.costa", { role: "Manager" }));
  });
  it("a teller cannot change someone's permissions", async () => {
    await refused(teller, desk("m.costa", { caps: { canVoid: true } }));
  });
  it("a manager cannot change the owner's role or their own", async () => {
    await refused(manager, desk("j.masri", { role: "Cashier" }));
    await refused(manager, desk("r.haddad", { role: "Cashier" }));
    await refused(manager, desk("n.owens", { caps: { canVoid: false } }));
  });
  it("a manager can change a teller's role, because a teller ranks strictly below", async () => {
    const saved = await put(manager, desk("s.iqbal", { role: "Senior teller" }));
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "s.iqbal").role).toBe("Senior teller");
  });
  it("adding a role that was not stored is a change", async () => {
    const planted = baseline();
    const employees = planted.cdos_settings.employees.map((p) => {
      if (p.code !== "j.masri") return p;
      const next: Record<string, unknown> = { ...p };
      delete next.role;
      return next;
    });
    planted.cdos_settings = { ...planted.cdos_settings, employees: employees as typeof planted.cdos_settings.employees };
    await handle.db.update(schema.tenantState).set({ state: planted }).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
    const denied = await put(teller, desk("j.masri", { role: "Cashier" }));
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().detail).toBe(REFUSAL);
    const row = (await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "j.masri");
    expect(row.role).toBeUndefined();
  });
  it("the owner can change their own role and someone else's", async () => {
    const own = await put(owner, desk("j.masri", { role: "Manager" }));
    expect(own.statusCode, own.body).toBe(200);
    expect((await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "j.masri").role).toBe("Manager");
    const other = await put(owner, desk("s.iqbal", { role: "Senior teller", caps: { canVoid: true } }), 2);
    expect(other.statusCode, other.body).toBe(200);
    expect((await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "s.iqbal").role).toBe("Senior teller");
  });
});

describe("removing a row or putting a person back is the same rank rule", () => {
  const audits = () => handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "settings.pin_rule_refused"));
  it("a teller cannot remove the owner, and the audit names the teller", async () => {
    const before = await audits();
    const denied = await app.inject({
      method: "PUT", url: "/api/tenant/state", cookies: teller,
      payload: { state: { ...without("j.masri"), actingUser: "j.masri" }, version: 1, actingUser: "j.masri", actorId: `${DEMO.tenantId}:j.masri` },
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().detail).toBe(PIN_ROW_REMOVAL);
    expect((await read()).json().state).toEqual(baseline());
    const after = await audits();
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)?.actorId).toBe(`${DEMO.tenantId}:s.iqbal`);
  });
  it("a teller cannot put the owner back as a teller", async () => {
    const planted = baseline();
    planted.cdos_settings.employees = planted.cdos_settings.employees.filter((p) => p.code !== "j.masri");
    await handle.db.update(schema.tenantState).set({ state: planted }).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
    const back = listed([...planted.cdos_settings.employees, { id: "e-new", name: "J. Masri", code: "j.masri", role: "teller" }]);
    const denied = await put(teller, back);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().detail).toBe(REFUSAL);
    expect((await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "j.masri")).toBeUndefined();
  });
  it("a new row that uses the owner's code, staff id, or id is an edit of the owner", async () => {
    const extra = { name: "Other", role: "teller" };
    await refused(teller, listed([...clonePeople(), { ...extra, id: "e-new", code: "j.masri" }]));
    await refused(teller, listed([...clonePeople(), { ...extra, id: "e-new", code: "x.new", staffId: "j.masri" }]));
    await refused(teller, listed([...clonePeople(), { ...extra, id: "j.masri", code: "x.new" }]));
  });
  it("a manager cannot remove the owner or themselves, and can remove a teller", async () => {
    await refused(manager, without("j.masri"), PIN_ROW_REMOVAL);
    await refused(manager, without("r.haddad"), PIN_ROW_REMOVAL);
    const saved = await put(manager, without("s.iqbal"));
    expect(saved.statusCode, saved.body).toBe(200);
    const employees = (await read()).json().state.cdos_settings.employees;
    expect(employees.find((p: { code: string }) => p.code === "s.iqbal")).toBeUndefined();
    expect(employees.find((p: { code: string }) => p.code === "j.masri").role).toBe("Owner");
  });
  it("the owner can remove a teller", async () => {
    const saved = await put(owner, without("m.costa"));
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "m.costa")).toBeUndefined();
  });
});

describe("the first copy of an empty list", () => {
  const first = () => ({ cdos_rows_v1: [{ id: "kept" }], cdos_settings: { employees: [{ id: "e-owner", name: "J. Masri", code: "j.masri", role: "Cashier" }] } });
  async function empty() {
    await handle.db.delete(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
  }
  it("a teller cannot name the owner as Cashier when nothing is stored yet", async () => {
    await empty();
    const denied = await put(teller, first(), 0);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().detail).toBe(REFUSAL);
    const stored = (await handle.db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId)).limit(1))[0];
    expect(JSON.stringify(stored?.state ?? {})).not.toContain("Cashier");
  });
  it("the owner can write that first copy", async () => {
    await empty();
    const saved = await put(owner, first(), 0);
    expect(saved.statusCode, saved.body).toBe(200);
    const row = (await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "j.masri");
    expect(row.role).toBe("Cashier");
  });
});
