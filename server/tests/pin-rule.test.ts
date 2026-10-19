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
import { clearPinAttempts, hashPin } from "../src/routes/pin.js";
import { backendRolePermissions, hasBackendPermission } from "../src/auth/permissions.js";
import { ownsSettings } from "../src/state/owner-settings.js";
import { isSessionOwner, OWNER_PERMISSION_GRANT, PIN_ROW_REMOVAL } from "../src/state/pin-rule.js";

const REFUSAL = "Only someone senior to this person can change their role or permissions.";
let handle: DbHandle;
let app: FastifyInstance;
let owner: Record<string, string>;
let teller: Record<string, string>;
let manager: Record<string, string>;
let compliance: Record<string, string>;
const OWNER_PIN = "Only the owner can change whether this person needs a PIN.";
const GRANT = OWNER_PERMISSION_GRANT;

const people = [
  { id: "e-owner", name: "J. Masri", code: "j.masri", role: "Owner", caps: { canVoid: false } },
  { id: "e-mgr", name: "R. Haddad", code: "r.haddad", role: "Manager", caps: { canVoid: true } },
  { id: "e-peer", name: "N. Owens", code: "n.owens", role: "Manager", caps: { canVoid: true } },
  { id: "e-tel", name: "M. Costa", code: "m.costa", role: "Cashier", caps: { canVoid: false } },
  { id: "e-iqbal", name: "S. Iqbal", code: "s.iqbal", role: "Cashier", caps: { canVoid: false } },
  { id: "e-comp", name: "C. Nadeau", code: "c.nadeau", role: "Compliance", caps: { canVoid: false } },
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
  const ownerHash = (await handle.db.select({ passwordHash: schema.staffUsers.passwordHash }).from(schema.staffUsers).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:j.masri`)).limit(1))[0];
  await handle.db.insert(schema.staffUsers).values([
    {
      id: `${DEMO.tenantId}:n.owens`, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId, staffId: "n.owens", name: "N. Owens", role: "branch_manager",
      authorizedBranchIds: [DEMO.branchId], passwordHash: "not-a-sign-in",
    },
    {
      id: `${DEMO.tenantId}:c.nadeau`, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId, staffId: "c.nadeau", name: "C. Nadeau", role: "compliance_officer",
      authorizedBranchIds: [DEMO.branchId], passwordHash: ownerHash?.passwordHash ?? "not-a-sign-in", mustChangePassword: false,
    },
  ]);
  for (const [staffId, pin] of [["a.singh", "4829"], ["s.iqbal", "7391"]] as const) {
    await handle.db.update(schema.staffUsers).set({ pinHash: await hashPin(pin), pinSetAt: new Date(), pinMustChange: false }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:${staffId}`));
  }
  app = await buildApp(handle.db);
  owner = await login("j.masri");
  teller = await login("s.iqbal");
  manager = await login("r.haddad");
  compliance = await login("c.nadeau");
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(async () => {
  clearPinAttempts(`${DEMO.tenantId}:a.singh`);
  clearPinAttempts(`${DEMO.tenantId}:s.iqbal`);
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

async function refusedAs(cookies: Record<string, string>, state: Record<string, unknown>, detail: string, action: "settings.pin_owner_refused" | "settings.pin_rule_refused", actorId: string) {
  const list = () => handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, action));
  const before = await list();
  const denied = await app.inject({
    method: "PUT", url: "/api/tenant/state", cookies,
    payload: { state: { ...state, actingUser: "j.masri" }, version: 1, actingUser: "j.masri", actorId: `${DEMO.tenantId}:j.masri` },
  });
  expect(denied.statusCode, denied.body).toBe(403);
  expect(denied.json().detail).toBe(detail);
  const after = await list();
  expect(after.length).toBe(before.length + 1);
  expect(after.at(-1)?.actorId).toBe(actorId);
}

describe("Require PIN and the switches are the owner's", () => {
  it("a teller cannot turn off Require PIN, and the audit names the session", async () => {
    await refusedAs(teller, desk("j.masri", { requirePin: false }), OWNER_PIN, "settings.pin_owner_refused", `${DEMO.tenantId}:s.iqbal`);
  });
  it("a manager cannot turn off a teller's Require PIN or a PIN switch", async () => {
    await refusedAs(manager, desk("s.iqbal", { requirePin: false }), OWNER_PIN, "settings.pin_owner_refused", `${DEMO.tenantId}:r.haddad`);
    const next = baseline();
    (next.cdos_settings as { pinOnSwitch?: boolean }).pinOnSwitch = false;
    await refusedAs(manager, next, "Only the owner can change whether a PIN is needed to switch accounts.", "settings.pin_owner_refused", `${DEMO.tenantId}:r.haddad`);
  });
  it("the owner can turn Require PIN off", async () => {
    const saved = await put(owner, desk("j.masri", { requirePin: false }));
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await read()).json().state.cdos_settings.employees.find((p: { code: string }) => p.code === "j.masri").requirePin).toBe(false);
  });
  it("a client actingUser does not get the rank refusal", async () => {
    await refusedAs(teller, desk("j.masri", { role: "Cashier" }), REFUSAL, "settings.pin_rule_refused", `${DEMO.tenantId}:s.iqbal`);
  });
  it("a client actingUser is not stored on a save that lands", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/tenant/state", cookies: teller,
      payload: { state: { ...baseline(), actingUser: "j.masri" }, version: 1, actingUser: "j.masri", actorId: `${DEMO.tenantId}:j.masri` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (await handle.db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId)).limit(1))[0];
    expect(row?.updatedBy).toBe(`${DEMO.tenantId}:s.iqbal`);
    expect(JSON.stringify(row?.state)).not.toContain("actingUser");
  });
  it("no non-owner can grant compliance:thresholds", async () => {
    expect(hasBackendPermission("compliance_officer", "compliance:thresholds")).toBe(false);
    expect(hasBackendPermission("administrator", "compliance:thresholds")).toBe(true);
    await refusedAs(teller, desk("s.iqbal", { permissions: { "compliance:thresholds": true } }), GRANT, "settings.pin_owner_refused", `${DEMO.tenantId}:s.iqbal`);
    const saved = await put(owner, desk("s.iqbal", { permissions: { "compliance:thresholds": true } }));
    expect(saved.statusCode, saved.body).toBe(200);
  });
  it("a compliance officer who holds compliance:thresholds is still not the owner", async () => {
    const held = backendRolePermissions.compliance_officer as unknown as string[];
    held.push("compliance:thresholds");
    try {
      expect(ownsSettings("compliance_officer")).toBe(true);
      expect(isSessionOwner("compliance_officer")).toBe(false);
      expect(isSessionOwner("administrator")).toBe(true);
      await refusedAs(compliance, desk("j.masri", { requirePin: false }), OWNER_PIN, "settings.pin_owner_refused", `${DEMO.tenantId}:c.nadeau`);
      await refusedAs(compliance, desk("c.nadeau", { role: "Owner" }), REFUSAL, "settings.pin_rule_refused", `${DEMO.tenantId}:c.nadeau`);
      await refusedAs(compliance, desk("n.owens", { role: "Cashier" }), REFUSAL, "settings.pin_rule_refused", `${DEMO.tenantId}:c.nadeau`);
      const saved = await put(owner, desk("j.masri", { requirePin: false }));
      expect(saved.statusCode, saved.body).toBe(200);
    } finally {
      held.pop();
    }
  });
});

describe("switch always requires a PIN", () => {
  async function attempt(staffId: string, pin?: string) {
    const cookies = await login("m.costa");
    await handle.db.update(schema.sessions).set({ workspaceId: null }).where(eq(schema.sessions.userId, `${DEMO.tenantId}:m.costa`));
    const payload: Record<string, string> = { staffId };
    if (pin !== undefined) payload.pin = pin;
    const res = await app.inject({ method: "POST", url: "/api/auth/switch", cookies, payload });
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    return { res, me };
  }
  it("refuses a switch with no PIN when the flag is off", async () => {
    expect((await put(owner, desk("j.masri", { requirePin: false }))).statusCode).toBe(200);
    const { res, me } = await attempt("j.masri");
    expect(res.statusCode, res.body).toBe(400);
    expect(me.json().user.id).toBe("m.costa");
  });
  it("switches when the PIN is right", async () => {
    const { res } = await attempt("a.singh", "4829");
    expect(res.statusCode, res.body).toBe(200);
  });
});
