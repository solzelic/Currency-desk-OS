/* ============================================================
   Adding a location, a till and an employee has to reach the server.

   All three were browser-only. "Add location" quoted $699/mo, wrote the
   desk's saved-state blob and created no branch; "Add till" created no
   workspace, which is what the ledger posts against; "Add employee"
   created nobody at all, and the people named during onboarding arrived
   with an empty password hash — on the roster, and unable to sign in.

   These tests go through the HTTP app and then look in the tables,
   because the whole defect was a screen that agreed with itself.
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

const login = async (staffId: string, password = DEMO.password) =>
  cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password } }));

const auditActions = async () => (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);

const addLocation = (cookies: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/desk/branches", cookies, payload });

const addTill = (cookies: Record<string, string>, branchId: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/desk/branches/${branchId}/tills`, cookies, payload });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("locations", () => {
  it("shows what the desk actually has, from the tables", async () => {
    expect((await app.inject({ method: "GET", url: "/api/desk/branches" })).statusCode).toBe(401);
    const teller = await login("m.costa");
    const res = await app.inject({ method: "GET", url: "/api/desk/branches", cookies: teller });
    expect(res.statusCode).toBe(200);
    const branches = res.json().branches as any[];
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ id: DEMO.branchId, name: "Yorkville Desk", authorized: true });
    expect(branches[0].tills).toEqual([expect.objectContaining({ workspaceId: DEMO.workspaceId, tillId: "till-01" })]);
  });

  it("is the owner's decision — a teller and a manager are both refused", async () => {
    for (const staffId of ["m.costa", "r.haddad"]) {
      const res = await addLocation(await login(staffId), { name: "Scarborough" });
      expect(res.statusCode).toBe(403);
    }
    expect(await handle.db.select().from(schema.branches).where(eq(schema.branches.name, "Scarborough"))).toHaveLength(0);
  });

  it("creates the branch, its first till and its rate board", async () => {
    const admin = await login("j.masri");
    const res = await addLocation(admin, { name: "Scarborough" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.branch.id).toBe("br-yorkfx-scarborough");
    expect(body.tills).toEqual([{ workspaceId: "ws-yorkfx-scarborough-till-01", tillId: "till-01" }]);
    expect(body.board.published).toBe(true);

    const branch = await handle.db.select().from(schema.branches).where(eq(schema.branches.id, "br-yorkfx-scarborough"));
    expect(branch).toHaveLength(1);
    expect(branch[0]).toMatchObject({ tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, name: "Scarborough" });
    // the clock came from the location they already run, not from a constant
    expect(branch[0]!.timezone).toBe("America/Toronto");

    const till = await handle.db.select().from(schema.workspaces).where(eq(schema.workspaces.branchId, "br-yorkfx-scarborough"));
    expect(till).toHaveLength(1);
    const board = await handle.db.select().from(schema.rateBoards).where(eq(schema.rateBoards.branchId, "br-yorkfx-scarborough"));
    expect(board).toHaveLength(1);
    expect(await auditActions()).toContain("branch.created");
  });

  it("quotes no price it cannot charge", async () => {
    const before = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId)))[0]!.plan;
    const res = await addLocation(await login("j.masri"), { name: "Scarborough" });
    expect(res.json().billing).toMatchObject({ charged: false, locations: 2 });
    expect(res.json().billing.detail).toMatch(/nothing was charged/i);
    const after = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId)))[0]!.plan;
    expect(after).toBe(before);
  });

  it("opening the same location twice opens one", async () => {
    const admin = await login("j.masri");
    const again = await addLocation(admin, { name: "  scarborough " });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, branch: { id: "br-yorkfx-scarborough" } });
    expect(await handle.db.select().from(schema.branches).where(eq(schema.branches.tenantId, DEMO.tenantId))).toHaveLength(2);
  });

  it("lets whoever opened it work there", async () => {
    const admin = await login("j.masri");
    const listed = (await app.inject({ method: "GET", url: "/api/desk/branches", cookies: admin })).json().branches as any[];
    const scarborough = listed.find((b) => b.id === "br-yorkfx-scarborough");
    expect(scarborough.authorized).toBe(true);
    // and the rate board at the new location is reachable with that session
    const rates = await app.inject({ method: "GET", url: "/api/rates?branchId=br-yorkfx-scarborough", cookies: admin });
    expect(rates.json().board).not.toBeNull();
  });
});

describe("tills", () => {
  it("puts another till in a branch, and says which workspace to send", async () => {
    const admin = await login("j.masri");
    const res = await addTill(admin, DEMO.branchId, { tillId: "till-02" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      created: true,
      workspaceId: "ws-yorkville-till-02",
      till: { tillId: "till-02", branchId: DEMO.branchId },
    });
    const rows = await handle.db.select().from(schema.workspaces).where(eq(schema.workspaces.branchId, DEMO.branchId));
    expect(rows.map((r) => r.tillId).sort()).toEqual(["till-01", "till-02"]);
    expect(await auditActions()).toContain("till.created");
  });

  it("is idempotent on the till it was asked for", async () => {
    const res = await addTill(await login("j.masri"), DEMO.branchId, { tillId: "till-02" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: false, till: { workspaceId: "ws-yorkville-till-02" } });
  });

  it("allocates the next free number when nobody says", async () => {
    const res = await addTill(await login("j.masri"), DEMO.branchId);
    expect(res.statusCode).toBe(201);
    expect(res.json().till.tillId).toBe("till-03");
  });

  it("a manager may equip their own branch and not one they cannot reach", async () => {
    const manager = await login("r.haddad");
    expect((await addTill(manager, DEMO.branchId, { tillId: "till-04" })).statusCode).toBe(201);
    expect((await addTill(manager, "br-yorkfx-scarborough", { tillId: "till-02" })).statusCode).toBe(403);
    expect((await addTill(manager, "br-nowhere", {})).statusCode).toBe(404);
  });

  it("refuses a teller outright", async () => {
    expect((await addTill(await login("m.costa"), DEMO.branchId, { tillId: "till-09" })).statusCode).toBe(403);
  });
});

describe("employees", () => {
  it("creates somebody with a real first sign-in, without inventing a password", async () => {
    const admin = await login("j.masri");
    const res = await app.inject({
      method: "POST", url: "/api/staff", cookies: admin,
      payload: { staffId: "p.novak", name: "P. Novak", role: "teller" },
    });
    expect(res.statusCode).toBe(201);
    const { staff, signIn } = res.json();
    expect(staff).toMatchObject({ staffId: "p.novak", role: "teller", canSignIn: true, mustChangePassword: true });
    // no address to send to, so the desk is handed the password to read out
    expect(signIn.delivered).toBe("no_address");
    expect(signIn.tempPassword).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{4}$/);
    expect(signIn.detail).toContain("p.novak");

    const first = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "p.novak", password: signIn.tempPassword } });
    expect(first.statusCode).toBe(200);
    expect(first.json().user.mustChangePassword).toBe(true);
  });

  it("emails the sign-in when the person has an address", async () => {
    const admin = await login("j.masri");
    const res = await app.inject({
      method: "POST", url: "/api/staff", cookies: admin,
      payload: { staffId: "h.osei@yorkfx.test", name: "H. Osei", role: "supervisor" },
    });
    expect(res.statusCode).toBe(201);
    const { signIn } = res.json();
    // no mail provider on this deployment: it says so rather than pretending
    expect(signIn.delivered).toBe("simulated");
    expect(signIn.sentTo).toBe("h.osei@yorkfx.test");
    expect(signIn.tempPassword).toBeTruthy();
    expect(signIn.detail).toMatch(/not connected/i);
  });

  it("hires into a location that exists, and refuses one that does not", async () => {
    const admin = await login("j.masri");
    const ok = await app.inject({
      method: "POST", url: "/api/staff", cookies: admin,
      payload: { staffId: "d.olu", name: "D. Olu", role: "branch_manager", branchId: "br-yorkfx-scarborough" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().staff).toMatchObject({ branchId: "br-yorkfx-scarborough", authorizedBranchIds: ["br-yorkfx-scarborough"] });

    const nowhere = await app.inject({
      method: "POST", url: "/api/staff", cookies: admin,
      payload: { staffId: "e.nobody", name: "E. Nobody", role: "teller", branchId: "br-does-not-exist" },
    });
    expect(nowhere.statusCode).toBe(400);
    expect(nowhere.json().error).toBe("no_such_branch");
  });

  it("names the people onboarding left without a credential, and lets the owner fix it", async () => {
    /* Exactly what src/onboarding/provision.ts writes for a team member
       the owner listed while setting the desk up. */
    await handle.db.insert(schema.staffUsers).values({
      id: `${DEMO.tenantId}:a.tarek@yorkfx.test`,
      tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId,
      staffId: "a.tarek@yorkfx.test", name: "A. Tarek", role: "teller",
      authorizedBranchIds: [DEMO.branchId],
      passwordHash: "", mustChangePassword: true, passwordUpdatedAt: null,
    }).onConflictDoNothing();

    const admin = await login("j.masri");
    const roster = (await app.inject({ method: "GET", url: "/api/staff", cookies: admin })).json().staff as any[];
    expect(roster.find((s) => s.staffId === "a.tarek@yorkfx.test")).toMatchObject({ canSignIn: false });

    const invite = await app.inject({ method: "POST", url: "/api/staff/a.tarek@yorkfx.test/invite", cookies: admin });
    expect(invite.statusCode).toBe(200);
    const { signIn } = invite.json();
    expect(signIn.tempPassword).toBeTruthy();

    const now = (await app.inject({ method: "GET", url: "/api/staff", cookies: admin })).json().staff as any[];
    expect(now.find((s) => s.staffId === "a.tarek@yorkfx.test")).toMatchObject({ canSignIn: true });
    const start = await app.inject({
      method: "POST", url: "/api/auth/login/start",
      payload: { staffId: "a.tarek@yorkfx.test", password: signIn.tempPassword },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().needsCode).toBe(true);
    expect(await auditActions()).toContain("staff.invited");
  });

  it("nobody re-invites themselves out of their own session", async () => {
    const admin = await login("j.masri");
    const res = await app.inject({ method: "POST", url: "/api/staff/j.masri/invite", cookies: admin });
    expect(res.statusCode).toBe(403);
  });
});
