/* Rates v2.5: Auto-publish, a board that follows the market.

   The hourly market sync used to refresh one board (York FX's), in CAD.
   A shop can now switch Auto-publish on for its branch: every pull then
   publishes its board again with the market's mids in the shop's own home
   currency, keeping its margins, spreads, shown currencies and order. A
   rate the shop pinned is never moved by the market. The switch is off
   until staff who may change rates turn it on, and every change is in the
   audit log. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { midsInHome, publishFromMarket, syncMarketRates, type MarketPull } from "../src/rates/market.js";
import { provisionDesk } from "../src/onboarding/provision.js";

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

/* A shop in Dubai: its own tenant, legal entity (home AED), branch and board. */
const DXB = { tenant: "tnt-dxb", entity: "le-dxb", branch: "br-dxb" };
async function dubaiShop(autoPublish: boolean) {
  await handle.db.insert(schema.tenants).values({ id: DXB.tenant, name: "Dubai Exchange" }).onConflictDoNothing();
  await handle.db.insert(schema.legalEntities).values({ id: DXB.entity, tenantId: DXB.tenant, name: "Dubai Exchange LLC", jurisdiction: "CBUAE", homeCurrency: "AED" }).onConflictDoNothing();
  await handle.db.insert(schema.branches).values({ id: DXB.branch, tenantId: DXB.tenant, legalEntityId: DXB.entity, name: "Deira", timezone: "Asia/Dubai", autoPublishRates: autoPublish })
    .onConflictDoUpdate({ target: schema.branches.id, set: { autoPublishRates: autoPublish } });
  await handle.db.insert(schema.rateBoards).values({ id: `dxb-${Date.now()}`, tenantId: DXB.tenant, legalEntityId: DXB.entity, branchId: DXB.branch, buyMargin: "0.01", sellMargin: "0.02", boardRows: { USD: { mid: 3.6725 }, EUR: { mid: 3.95, spread: 0.03 }, GBP: { mid: 4.6, pinned: true } }, boardOrder: ["USD", "EUR", "GBP"], publishedBy: "seed" });
}
/* CAD per unit, as the feeds give them. */
const PULL: MarketPull = { provider: "test-feed", providerTimestamp: null, mids: { USD: 1.37, EUR: 1.47, GBP: 1.74, AED: 0.373 } };

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });

describe("the market in the shop's own currency", () => {
  it("divides the CAD feed by the home currency, as the desk's Board does", () => {
    const aed = midsInHome(PULL.mids, "AED")!;
    expect(aed.USD).toBeCloseTo(1.37 / 0.373, 10);
    expect(aed.CAD).toBeCloseTo(1 / 0.373, 10);
    expect(aed).not.toHaveProperty("AED");
    expect(midsInHome(PULL.mids, "CAD")).toEqual(PULL.mids);
    expect(midsInHome(PULL.mids, "JPY")).toBeNull();
  });

  it("publishes a Dubai board in dirhams, keeps its spreads and order, and leaves a pinned rate alone", async () => {
    await dubaiShop(true);
    await publishFromMarket(handle.db, PULL, DXB.branch);
    const board = await newest(DXB.branch);
    expect(board.publishedBy).toBe("market-sync (test-feed)");
    expect(board.boardRows.USD!.mid).toBeCloseTo(1.37 / 0.373, 8);
    expect(board.boardRows.EUR).toMatchObject({ spread: 0.03 });
    expect(board.boardRows.GBP).toEqual({ mid: 4.6, pinned: true });
    expect(board.boardOrder).toEqual(["USD", "EUR", "GBP"]);
    expect(Number(board.sellMargin)).toBeCloseTo(0.02);
  });

  it("does not publish a board whose home currency the feed does not have", async () => {
    const before = await newest(DXB.branch);
    expect(await publishFromMarket(handle.db, { ...PULL, mids: { USD: 1.37 } }, DXB.branch)).toBeNull();
    expect((await newest(DXB.branch)).id).toBe(before.id);
  });
});

describe("the Auto-publish switch", () => {
  it("is off until staff who may change rates turn it on; a teller cannot; each change is audited", async () => {
    expect((await as("r.haddad", "GET", "/api/rates")).json().autoPublish).toBe(false);
    expect((await as("m.costa", "PUT", "/api/rates/auto-publish", { on: true })).statusCode).toBe(403);
    const on = await as("r.haddad", "PUT", "/api/rates/auto-publish", { on: true });
    expect(on.statusCode, on.body).toBe(200);
    expect((await as("m.costa", "GET", "/api/rates")).json().autoPublish).toBe(true);
    expect((await as("r.haddad", "PUT", "/api/rates/auto-publish", { on: "yes" })).statusCode).toBe(400);
    const audit = await handle.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "rates.auto_publish"), eq(schema.auditEvents.tenantId, DEMO.tenantId)));
    expect(audit.map((a) => a.detail)).toEqual([{ old: false, new: true }]);
    await as("r.haddad", "PUT", "/api/rates/auto-publish", { on: false });
  });

  it("the sync publishes every branch that has it on, and leaves the rest", async () => {
    await dubaiShop(true);
    await handle.db.insert(schema.tenants).values({ id: "tnt-off", name: "Off Exchange" }).onConflictDoNothing();
    await handle.db.insert(schema.legalEntities).values({ id: "le-off", tenantId: "tnt-off", name: "Off", jurisdiction: "FINTRAC", homeCurrency: "CAD" }).onConflictDoNothing();
    await handle.db.insert(schema.branches).values({ id: "br-off", tenantId: "tnt-off", legalEntityId: "le-off", name: "Off" }).onConflictDoNothing();
    await handle.db.insert(schema.rateBoards).values({ id: "off-board", tenantId: "tnt-off", legalEntityId: "le-off", branchId: "br-off", buyMargin: "0.01", sellMargin: "0.01", boardRows: { USD: { mid: 1.2 } }, publishedBy: "seed" }).onConflictDoNothing();
    const dubaiBefore = (await newest(DXB.branch)).id;

    const result = await syncMarketRates(handle.db, DEMO.branchId, async () => ({ ...PULL, mids: { ...PULL.mids, AED: 0.372 } }));
    expect(result.ok, result.detail).toBe(true);
    const dubai = await newest(DXB.branch);
    expect(dubai.id).not.toBe(dubaiBefore);
    expect(dubai.boardRows.USD!.mid).toBeCloseTo(1.37 / 0.372, 8);
    expect((await newest("br-off")).id).toBe("off-board");
    expect((await newest(DEMO.branchId)).publishedBy).toBe("market-sync (test-feed)");
  });
});

describe("a new shop", () => {
  /* Sol, 5 Nov 2026: new shops start with Auto-publish on. While the
     hourly sync runs a board can be quoted for 70 minutes, so a shop that
     never switched it on would stop quoting within the hour. Shops that
     already exist keep what they have. */
  it("opens with Auto-publish on, and a shop that already exists keeps its own", async () => {
    const made = await provisionDesk(handle.db, {
      businessName: "Fresh Exchange", legalName: "Fresh Exchange Inc.", ownerName: "Owner", email: "fresh@example.test",
      slug: "fresh-exchange", plan: "pro", setup: { country: "CA", homeCurrency: "CAD" }, msbNumber: null, regulator: "FINTRAC", team: [],
    }, "hash", "test");
    const branch = (await handle.db.select().from(schema.branches).where(eq(schema.branches.tenantId, made.tenantId)))[0]!;
    expect(branch.autoPublishRates).toBe(true);
    expect((await handle.db.select().from(schema.branches).where(eq(schema.branches.id, DEMO.branchId)))[0]!.autoPublishRates).toBe(false);
  });
});
