/* Rates v2.5: Lock rates.

   The design's header has a Lock rates button. A locked branch's rates do
   not change until an owner or manager unlocks them: nobody can publish
   (the server refuses, whatever screen sent it), and Auto-publish leaves
   the board alone. Locking is for staff who may change rates; each lock
   and unlock is in the audit log with who and when. The lock belongs to
   one branch: another shop's board is not touched. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { publishFromMarket, syncMarketRates, type MarketPull } from "../src/rates/market.js";

let handle: DbHandle;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
async function login(staffId: string) {
  if (cookies[staffId]) return cookies[staffId]!;
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });
  return (cookies[staffId] = { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value });
}
const as = async (staffId: string, method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, cookies: await login(staffId), payload });
const newest = async (branchId: string) => (await handle.db.select().from(schema.rateBoards)
  .where(eq(schema.rateBoards.branchId, branchId)).orderBy(desc(schema.rateBoards.publishedAt)).limit(1))[0]!;
const PULL: MarketPull = { provider: "test-feed", providerTimestamp: null, mids: { USD: 1.37, EUR: 1.47, GBP: 1.74 } };
const BODY = { buyMargin: 0.01, sellMargin: 0.01, rows: { USD: { mid: 1.36 } } };

/* Another shop with its own board and Auto-publish on. */
const OTHER = { tenant: "tnt-lock-other", entity: "le-lock-other", branch: "br-lock-other" };

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  await handle.db.insert(schema.tenants).values({ id: OTHER.tenant, name: "Other Exchange" });
  await handle.db.insert(schema.legalEntities).values({ id: OTHER.entity, tenantId: OTHER.tenant, name: "Other", jurisdiction: "FINTRAC", homeCurrency: "CAD" });
  await handle.db.insert(schema.branches).values({ id: OTHER.branch, tenantId: OTHER.tenant, legalEntityId: OTHER.entity, name: "Other", autoPublishRates: true });
  await handle.db.insert(schema.rateBoards).values({ id: "other-board", tenantId: OTHER.tenant, legalEntityId: OTHER.entity, branchId: OTHER.branch, buyMargin: "0.01", sellMargin: "0.01", boardRows: { USD: { mid: 1.2 } }, publishedBy: "seed" });
});
afterAll(async () => { await app.close(); await handle.close(); });

describe("Lock rates", () => {
  it("is open until a manager locks it; the board then says who locked it and when", async () => {
    expect((await as("r.haddad", "GET", "/api/rates")).json().locked).toBeNull();
    const res = await as("r.haddad", "PUT", "/api/rates/lock", { locked: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().locked).toMatchObject({ by: "r.haddad" });
    expect(typeof res.json().locked.at).toBe("number");
    const seen = (await as("m.costa", "GET", "/api/rates")).json();
    expect(seen.locked).toMatchObject({ by: "r.haddad" });
  });

  it("refuses a publish while locked, from any screen, and leaves the board as it was", async () => {
    const before = await newest(DEMO.branchId);
    const res = await as("r.haddad", "POST", "/api/rates/publish", BODY);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "rates_locked" });
    expect((await newest(DEMO.branchId)).id).toBe(before.id);
  });

  it("keeps the market off a locked board, even with Auto-publish on, and still moves other shops' boards", async () => {
    await handle.db.update(schema.branches).set({ autoPublishRates: true }).where(eq(schema.branches.id, DEMO.branchId));
    const before = await newest(DEMO.branchId);
    expect(await publishFromMarket(handle.db, PULL, DEMO.branchId)).toBeNull();
    const result = await syncMarketRates(handle.db, DEMO.branchId, async () => PULL);
    expect(result.ok, result.detail).toBe(true);
    expect((await newest(DEMO.branchId)).id).toBe(before.id);
    expect((await newest(OTHER.branch)).id).not.toBe("other-board");
    await handle.db.update(schema.branches).set({ autoPublishRates: false }).where(eq(schema.branches.id, DEMO.branchId));
  });

  it("is for staff who may change rates: a teller can neither lock nor unlock", async () => {
    expect((await as("m.costa", "PUT", "/api/rates/lock", { locked: false })).statusCode).toBe(403);
    expect((await as("r.haddad", "GET", "/api/rates")).json().locked).not.toBeNull();
  });

  it("takes only a yes or no", async () => {
    expect((await as("r.haddad", "PUT", "/api/rates/lock", { locked: "yes" })).statusCode).toBe(400);
    expect((await as("r.haddad", "PUT", "/api/rates/lock", { locked: true, branchId: OTHER.branch })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/rates/lock", payload: { locked: false } })).statusCode).toBe(401);
  });

  it("unlocks, publishing works again, and both changes are in the audit log", async () => {
    const res = await as("r.haddad", "PUT", "/api/rates/lock", { locked: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().locked).toBeNull();
    expect((await as("r.haddad", "POST", "/api/rates/publish", BODY)).statusCode).toBe(200);
    const audit = await handle.db.select().from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "rates.lock"), eq(schema.auditEvents.tenantId, DEMO.tenantId)));
    expect(audit.map((a) => a.detail)).toEqual([{ old: false, new: true }, { old: true, new: false }]);
  });

  it("locks only this branch: another shop is never locked by it", async () => {
    await as("r.haddad", "PUT", "/api/rates/lock", { locked: true });
    const other = (await handle.db.select().from(schema.branches).where(eq(schema.branches.id, OTHER.branch)))[0]!;
    expect(other.ratesLockedAt).toBeNull();
    await as("r.haddad", "PUT", "/api/rates/lock", { locked: false });
  });
});
