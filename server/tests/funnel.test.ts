/* The early-access funnel, end to end: an application arrives from the public
   site, the operator works it in the control panel, and when the applicant
   creates their desk the application is closed against it. That last join is
   what makes it a funnel rather than two unrelated lists. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];

// the seeded York administrator doubles as the platform operator here, the
// same way the other admin tests do — a staff id, so no code step to drive
const ADMIN = "j.masri";
let adminCookie: Record<string, string> = {};

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((l) => l.includes("[email simulated]"));
  const m = line?.match(/(\d{6}) is your/) ?? line?.match(/code is (\d{6})/);
  if (!m) throw new Error("no code in log: " + JSON.stringify(logged));
  return m[1]!;
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);

  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = login.cookies.find((x) => x.name === "cdos_session");
  adminCookie = c ? { cdos_session: c.value } : {};
});
afterAll(async () => {
  await app.close();
  await handle.close();
  vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});
beforeEach(() => { logged = []; });

const apply = (email: string, details: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/api/enquiries", payload: { kind: "early_access", email, name: "Amir Rostami", details } });
const list = (qs = "") =>
  app.inject({ method: "GET", url: "/api/admin/enquiries" + qs, cookies: adminCookie });

describe("the early-access funnel", () => {
  it("an application from the site lands in the control panel, already in review", async () => {
    const sent = await apply("amir@yorkville.example", { workspace: "yorkville.currencydeskos.com", jurisdiction: "CA", monthlyVolume: "Under $500K" });
    expect(sent.statusCode).toBe(201);

    const res = await list("?kind=early_access");
    expect(res.statusCode).toBe(200);
    const row = res.json().enquiries.find((e: { email: string }) => e.email === "amir@yorkville.example");
    expect(row).toBeTruthy();
    /* Not "new" waiting to be noticed. Arriving IS being in review — there
       is no stage before somebody is looking, because the applicant hears
       nothing while one exists. */
    expect(row.status).toBe("reviewing");
    expect(row.tenantId).toBeNull();
    // every answer the applicant gave is there to read
    expect(row.details).toMatchObject({ jurisdiction: "CA", monthlyVolume: "Under $500K" });
  });

  it("the overview counts what is waiting on someone", async () => {
    const ov = await app.inject({ method: "GET", url: "/api/admin/overview", cookies: adminCookie });
    expect(ov.statusCode).toBe(200);
    expect(ov.json().funnel.applications).toBeGreaterThan(0);
    expect(ov.json().funnel.waiting).toBeGreaterThan(0);
  });

  it("the operator moves it along, and the move is on the record", async () => {
    const row = (await list("?kind=early_access")).json().enquiries[0];
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/admin/enquiries/${row.id}`,
      cookies: adminCookie,
      payload: { status: "invited", notes: "Two tellers, mostly USD. Walked them through on a call." },
    });
    expect(patch.statusCode).toBe(200);

    const after = (await list("?kind=early_access")).json().enquiries.find((e: { id: string }) => e.id === row.id);
    expect(after.status).toBe("invited");
    expect(after.notes).toContain("Two tellers");
    expect(after.decidedBy).toBe(ADMIN);

    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("admin.enquiry_status");
  });

  it("filters to just what needs attention", async () => {
    await apply("second@shop.example");
    const invited = (await list("?kind=early_access&status=invited")).json().enquiries;
    expect(invited.length).toBeGreaterThan(0);
    expect(invited.every((e: { status: string }) => e.status === "invited")).toBe(true);
  });

  it("acceptance is not something an operator can just assert", async () => {
    const row = (await list("?kind=early_access")).json().enquiries[0];
    const res = await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: adminCookie, payload: { status: "accepted" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_settable");
  });

  it("creating the desk is what closes the application, and links the two", async () => {
    await apply("dana@newdesk.example");
    // the invite is the gate now, so an application has to be invited before
    // its operator can open a desk
    const dana = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "dana@newdesk.example")))[0]!;
    await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${dana.id}`, cookies: adminCookie, payload: { status: "invited" } });
    await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: { businessName: "New Desk FX", ownerName: "Dana Kim", email: "dana@newdesk.example", password: "a-strong-pass", slug: "newdesk" },
    });
    const done = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "dana@newdesk.example", code: codeFromLog() } });
    expect(done.statusCode).toBe(201);

    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "dana@newdesk.example")))[0]!;
    expect(row.status).toBe("accepted");
    expect(row.tenantId).toBe("tnt-newdesk");
    expect(row.decidedBy).toBe("signup");

    // and the panel can say what the application became
    const shown = (await list("?kind=early_access")).json().enquiries.find((e: { id: string }) => e.id === row.id);
    expect(shown.tenantName).toBe("New Desk FX");
  });

  /* This used to read "a desk that never applied still gets created". The site
     promises a first cohort of a hundred places you apply for, and a wizard
     anyone could reach made that decoration — so the door is shut unless the
     operator has invited the address. */
  it("nobody opens a desk without being invited to", async () => {
    const walkIn = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: { businessName: "Walk In FX", ownerName: "Sam Lee", email: "sam@walkin.example", password: "a-strong-pass", slug: "walkin" },
    });
    expect(walkIn.statusCode).toBe(403);
    expect(walkIn.json().error).toBe("not_invited");

    // applying is not being invited — the operator still decides
    await apply("sam@walkin.example");
    expect((await app.inject({
      method: "POST", url: "/api/signup",
      payload: { businessName: "Walk In FX", ownerName: "Sam Lee", email: "sam@walkin.example", password: "a-strong-pass", slug: "walkin" },
    })).statusCode).toBe(403);

    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "sam@walkin.example")))[0]!;
    await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: adminCookie, payload: { status: "invited" } });
    const nowOk = await app.inject({
      method: "POST", url: "/api/signup",
      payload: { businessName: "Walk In FX", ownerName: "Sam Lee", email: "sam@walkin.example", password: "a-strong-pass", slug: "walkin" },
    });
    expect(nowOk.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "sam@walkin.example", code: codeFromLog() } })).statusCode).toBe(201);
  });

  it("opens to everyone when early access is over", async () => {
    process.env.EARLY_ACCESS_OPEN = "1";
    const res = await app.inject({
      method: "POST", url: "/api/signup",
      payload: { businessName: "Later FX", ownerName: "Pat Ng", email: "pat@later.example", password: "a-strong-pass", slug: "laterfx" },
    });
    expect(res.statusCode).toBe(201);
    delete process.env.EARLY_ACCESS_OPEN;
  });

  it("none of this is reachable without being a platform admin", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/enquiries" })).statusCode).toBe(401);
    const staff = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } });
    const c = staff.cookies.find((x) => x.name === "cdos_session");
    const asStaff = await app.inject({ method: "GET", url: "/api/admin/enquiries", cookies: c ? { cdos_session: c.value } : {} });
    expect(asStaff.statusCode).toBe(403);
  });
});
