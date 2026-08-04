/* ============================================================
   Blocking a desk has to take it offline.

   The panel says "Blocking takes a desk offline and keeps every
   record", and for a long time only the second half was true:
   `tenants.suspended` refused a NEW sign-in and did nothing at all to
   the sessions already open. A desk blocked for publishing a 9% board
   could keep publishing it until the cookie expired twelve hours
   later — which is to say, for the rest of the day somebody was
   watching.

   These tests hold a live session across the block, which is the only
   way to see the bug: sign in, suspend from the platform panel, then
   write with the cookie that was already in hand.
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const OPERATOR = { staffId: "ops.control", password: "platform-operator-1" };

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

const login = (staffId: string, password: string, tenantId = DEMO.tenantId) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password, tenantId } });

const asOperator = async () => cookieOf(await login(OPERATOR.staffId, OPERATOR.password, "tnt-platform"));

const board = { buyMargin: 0.02, sellMargin: 0.02, rows: { USD: { mid: 1.37, show: true } } };

const publish = (cookies: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/rates/publish", cookies, payload: board });

const suspend = async (cookies: Record<string, string>, suspended: boolean) =>
  app.inject({
    method: "PATCH",
    url: `/api/admin/tenants/${DEMO.tenantId}`,
    cookies,
    payload: { suspended },
  });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.PLATFORM_ADMIN_EMAILS = OPERATOR.staffId;
  handle = await createDb();
  await seed(handle.db);

  /* The platform operator gets a desk of their own. Suspending a customer
     from an account that lives ON that customer's desk would sign the
     operator out mid-click, which is a fine way to write a test that
     passes for the wrong reason. */
  const db = handle.db;
  await db.insert(schema.tenants).values({ id: "tnt-platform", name: "CurrencyDesk" }).onConflictDoNothing();
  await db.insert(schema.legalEntities).values({ id: "le-platform", tenantId: "tnt-platform", name: "CurrencyDesk Inc." }).onConflictDoNothing();
  await db.insert(schema.branches).values({ id: "br-platform", tenantId: "tnt-platform", legalEntityId: "le-platform", name: "Control" }).onConflictDoNothing();
  await db.insert(schema.staffUsers).values({
    id: "tnt-platform:" + OPERATOR.staffId,
    tenantId: "tnt-platform", legalEntityId: "le-platform", branchId: "br-platform",
    staffId: OPERATOR.staffId, name: "Platform Operator", role: "administrator",
    authorizedBranchIds: ["br-platform"],
    passwordHash: await hashPassword(OPERATOR.password),
  }).onConflictDoNothing();

  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("a suspended desk goes offline", () => {
  it("refuses writes on a session that was already signed in when the block landed", async () => {
    const desk = cookieOf(await login("r.haddad", DEMO.password));
    expect(Object.keys(desk).length).toBe(1);
    // the same call, before the block, works — so a failure afterwards is the block
    expect((await publish(desk)).statusCode).toBe(200);

    const operator = await asOperator();
    expect((await suspend(operator, true)).statusCode).toBe(200);

    const after = await publish(desk);
    expect(after.statusCode).not.toBe(200);
    expect([401, 403]).toContain(after.statusCode);

    // and nothing else that session holds still works either
    expect((await app.inject({ method: "GET", url: "/api/staff", cookies: desk })).statusCode).not.toBe(200);
    const state = await app.inject({
      method: "PUT", url: "/api/tenant/state", cookies: desk,
      payload: { state: { cdos_settings: "{}" } },
    });
    expect(state.statusCode).not.toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: desk })).statusCode).not.toBe(200);

    // a fresh sign-in was already refused, and still is
    expect((await login("r.haddad", DEMO.password)).statusCode).toBe(403);

    // unblocking puts the desk back without asking anybody to sign in again
    expect((await suspend(operator, false)).statusCode).toBe(200);
    expect((await publish(desk)).statusCode).toBe(200);
    expect((await login("r.haddad", DEMO.password)).statusCode).toBe(200);
  });

  it("blocking one desk leaves every other desk alone", async () => {
    const operator = await asOperator();
    expect((await suspend(operator, true)).statusCode).toBe(200);
    // the operator's own desk is untouched, so the panel still works
    const list = await app.inject({ method: "GET", url: "/api/admin/tenants", cookies: operator });
    expect(list.statusCode).toBe(200);
    expect((await suspend(operator, false)).statusCode).toBe(200);
  });

  /* The operator above has a desk of their own, which is the tidy
     arrangement and not the shipped one: the seeded platform owner
     `j.masri` is a member of staff at York FX. Checking suspension on every
     request — which is what makes the block real — therefore has a way to
     bite the person doing the blocking, and the way out of it is a database
     console. So the panel resolves a session whose desk is blocked far
     enough to ask "are you on the platform team", and no further. */
  it("does not lock the operator out of the panel when their own desk is the one blocked", async () => {
    const inHouse = "j.masri";
    /* Added to the team table directly: PLATFORM_ADMIN_EMAILS is read once,
       on first boot, and deliberately never overwrites an existing team —
       see seedOwner. */
    await handle.db.insert(schema.platformUsers).values({
      email: inHouse, name: "Jordan Masri", role: "support",
      status: "active", addedBy: "test",
    }).onConflictDoNothing();
    try {
      const panel = cookieOf(await login(inHouse, DEMO.password));
      expect(Object.keys(panel).length).toBe(1);
      expect((await app.inject({ method: "GET", url: "/api/admin/me", cookies: panel })).json().isAdmin).toBe(true);

      // they block the desk their own staff account sits on
      expect((await suspend(panel, true)).statusCode).toBe(200);

      // the panel still answers them, and — the point — they can undo it
      expect((await app.inject({ method: "GET", url: "/api/admin/tenants", cookies: panel })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/admin/me", cookies: panel })).json().isAdmin).toBe(true);
      expect((await suspend(panel, false)).statusCode).toBe(200);

      /* And the blocked desk is still blocked for everybody else on it —
         being on the platform team is not a way to keep trading through a
         block, it is a way to lift one. */
      expect((await suspend(panel, true)).statusCode).toBe(200);
      const teller = cookieOf(await login("r.haddad", DEMO.password));
      expect(Object.keys(teller).length).toBe(0);
      expect((await suspend(panel, false)).statusCode).toBe(200);
    } finally {
      await handle.db.delete(schema.platformUsers).where(eq(schema.platformUsers.email, inHouse));
    }
  });

  it("records who blocked the desk", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("admin.desk_suspended");
    expect(actions).toContain("admin.desk_unsuspended");
  });
});
