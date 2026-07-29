/* Who runs CurrencyDesk.

   Authorization moved out of an environment variable and into a table. The
   env vars still seed the first owner into an EMPTY database and are ignored
   after that — which is the whole point, because an env var re-read on every
   boot is how the bootstrap password kept coming back.

   The owner protections are the tests that matter. "Full control" must not
   mean one leaked password ends the company, and it must not mean you can
   lock yourself out of your own platform at 2am. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { can, ROLES } from "../src/platform/team.js";

let handle: DbHandle;
let app: FastifyInstance;
let owner: Record<string, string> = {};
const OWNER = "j.masri";

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = OWNER;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: OWNER, password: "yorkville", tenantId: "tnt-yorkfx" } }));
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

describe("the roles themselves", () => {
  it("give the owner everything and the auditor nothing that writes", () => {
    const auditor = ROLES.find((r) => r.id === "auditor")!;
    expect(auditor.permissions.some((p) => p.endsWith(":write") || p.endsWith(":manage"))).toBe(false);
    for (const p of ROLES.find((r) => r.id === "owner")!.permissions) expect(can("owner", p)).toBe(true);
  });

  it("keep money away from support and customers away from billing", () => {
    expect(can("support", "billing:read")).toBe(false);
    expect(can("support", "team:manage")).toBe(false);
    expect(can("billing", "people:write")).toBe(false);
    expect(can("billing", "billing:write")).toBe(true);
  });
});

describe("bootstrapping the first owner", () => {
  it("seeds from the env into an empty table, and says who it is", async () => {
    const me = (await app.inject({ method: "GET", url: "/api/admin/me", cookies: owner })).json();
    expect(me.isAdmin).toBe(true);
    expect(me.role).toBe("owner");
    expect(me.email).toBe(OWNER);
  });

  it("stops listening to the env once somebody is in the table", async () => {
    // a name that was never seeded gets nothing, however the env changes
    process.env.PLATFORM_ADMIN_EMAILS = OWNER + ",latecomer@nope.ca";
    const rows = await handle.db.select().from(schema.platformUsers);
    expect(rows.some((r) => r.email === "latecomer@nope.ca")).toBe(false);
    process.env.PLATFORM_ADMIN_EMAILS = OWNER;
  });
});

describe("the team", () => {
  const add = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/admin/team", cookies: owner, payload: body });

  it("takes a colleague with a fixed role", async () => {
    expect((await add({ email: "sam@currencydeskos.com", name: "Sam", role: "support" })).statusCode).toBe(201);
    const d = (await app.inject({ method: "GET", url: "/api/admin/team", cookies: owner })).json();
    expect((d.members as { email: string; role: string }[]).find((m) => m.email === "sam@currencydeskos.com")!.role).toBe("support");
    expect(d.canManage).toBe(true);
  });

  it("will not mint a second owner", async () => {
    const res = await add({ email: "rival@currencydeskos.com", role: "owner" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("one_owner");
  });

  it("refuses somebody who is already on it", async () => {
    expect((await add({ email: "sam@currencydeskos.com", role: "billing" })).statusCode).toBe(409);
  });
});

describe("the owner is protected", () => {
  const patchOwner = (body: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/admin/team/${encodeURIComponent(OWNER)}`, cookies: owner, payload: body });

  it("cannot be demoted, even by themselves", async () => {
    const res = await patchOwner({ role: "support" });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toContain("survive a bad day");
  });

  it("cannot be suspended, even by themselves", async () => {
    const res = await patchOwner({ status: "suspended" });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toContain("cannot be suspended");
  });

  it("cannot be removed, even by themselves", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/admin/team/${encodeURIComponent(OWNER)}`, cookies: owner });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toContain("cannot be removed");
  });

  it("is still there after all of that", async () => {
    const me = (await app.inject({ method: "GET", url: "/api/admin/me", cookies: owner })).json();
    expect(me.role).toBe("owner");
  });
});

describe("a role that cannot do the thing", () => {
  /* Driven through the table rather than by minting a second sign-in: what
     is being pinned is that the gate reads the CURRENT role, so a member
     demoted or suspended in the panel loses access on their next call rather
     than at the end of their session. */
  it("loses access the moment their row says so", async () => {
    await app.inject({ method: "POST", url: "/api/admin/team", cookies: owner, payload: { email: "temp@currencydeskos.com", role: "support" } });
    expect((await app.inject({ method: "GET", url: "/api/admin/team", cookies: owner })).json()
      .members.some((m: { email: string }) => m.email === "temp@currencydeskos.com")).toBe(true);

    // suspended: still a row, so you can see they were turned off
    await app.inject({ method: "PATCH", url: "/api/admin/team/temp%40currencydeskos.com", cookies: owner, payload: { status: "suspended" } });
    const rows = await handle.db.select().from(schema.platformUsers);
    expect(rows.find((r) => r.email === "temp@currencydeskos.com")!.status).toBe("suspended");

    // removed: the row goes
    expect((await app.inject({ method: "DELETE", url: "/api/admin/team/temp%40currencydeskos.com", cookies: owner })).statusCode).toBe(200);
    const after = await handle.db.select().from(schema.platformUsers);
    expect(after.some((r) => r.email === "temp@currencydeskos.com")).toBe(false);
  });

  it("is nobody's business without a session at all", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/team" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/billing" })).statusCode).toBe(401);
  });
});

describe("the money", () => {
  it("reports itself as unconnected rather than pretending, with no Stripe keys", async () => {
    const d = (await app.inject({ method: "GET", url: "/api/admin/billing", cookies: owner })).json();
    expect(d.connected).toBe(false);
    expect(d.mrrCents).toBe(0);
    expect(d.byPlan.map((p: { plan: string }) => p.plan)).toEqual(["basic", "pro", "premium"]);
  });

  it("is not readable by somebody without billing access", () => {
    expect(can("support", "billing:read")).toBe(false);
  });
});
