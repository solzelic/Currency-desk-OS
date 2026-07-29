/* The rates a visitor to a customer's website actually sees.

   The desk publishes a board to rate_boards. Until this endpoint existed
   nothing public read it — the storefront's numbers came out of the
   publisher's own localStorage, so they existed for one browser and nobody
   else. This is the join between what the desk trades at and what its
   customers are shown.

   The margin maths is the part worth guarding. Margins are stored as
   FRACTIONS (the publish schema caps them at 0.2, so 0.02 is two percent).
   Reading them as percentages puts a spread on the public site a hundred
   times tighter than the desk's — a number a walk-in customer could
   reasonably hold them to. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let cookie: Record<string, string> = {};

const publish = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/rates/publish", cookies: cookie, payload });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: DEMO.password } });
  const c = res.cookies.find((x) => x.name === "cdos_session");
  cookie = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); });

describe("what the website serves", () => {
  it("prices exactly the way the desk does, with the margin as a fraction", async () => {
    await publish({ buyMargin: 0.02, sellMargin: 0.03, rows: { USD: { mid: 2 } }, order: ["USD"] });
    const d = (await app.inject({ method: "GET", url: "/api/sites/yorkfx/rates" })).json();
    const usd = d.rates.find((r: { code: string }) => r.code === "USD");
    // 2% under mid and 3% over — not 0.02% and 0.03%
    expect(usd).toEqual({ code: "USD", buy: 1.96, sell: 2.06 });
  });

  it("lets a per-currency spread override the board margin, both sides", async () => {
    await publish({ buyMargin: 0.02, sellMargin: 0.02, rows: { USD: { mid: 2 }, GBP: { mid: 2, spread: 0.10 } }, order: ["USD", "GBP"] });
    const d = (await app.inject({ method: "GET", url: "/api/sites/yorkfx/rates" })).json();
    const gbp = d.rates.find((r: { code: string }) => r.code === "GBP");
    expect(gbp).toEqual({ code: "GBP", buy: 1.8, sell: 2.2 });
  });

  it("keeps the desk's own order, and hides what the desk hid", async () => {
    await publish({
      buyMargin: 0.02, sellMargin: 0.02,
      rows: { USD: { mid: 1.37 }, EUR: { mid: 1.48 }, JPY: { mid: 0.0092, show: false } },
      order: ["EUR", "USD", "JPY"],
    });
    const d = (await app.inject({ method: "GET", url: "/api/sites/yorkfx/rates" })).json();
    expect(d.rates.map((r: { code: string }) => r.code)).toEqual(["EUR", "USD"]);
    expect(d.currencies).toBe(2);
  });

  it("serves the newest board, so publishing is what changes the website", async () => {
    await publish({ buyMargin: 0.02, sellMargin: 0.02, rows: { USD: { mid: 1 } }, order: ["USD"] });
    const first = (await app.inject({ method: "GET", url: "/api/sites/yorkfx/rates" })).json();
    await publish({ buyMargin: 0.02, sellMargin: 0.02, rows: { USD: { mid: 5 } }, order: ["USD"] });
    const second = (await app.inject({ method: "GET", url: "/api/sites/yorkfx/rates" })).json();
    expect(first.rates[0].buy).toBeCloseTo(0.98, 6);
    expect(second.rates[0].buy).toBeCloseTo(4.9, 6);
  });

  it("needs no session — it is a public website", async () => {
    expect((await app.inject({ method: "GET", url: "/api/sites/yorkfx/rates" })).statusCode).toBe(200);
  });

  it("says nothing about a desk that does not exist", async () => {
    expect((await app.inject({ method: "GET", url: "/api/sites/nobody/rates" })).statusCode).toBe(404);
  });
});

describe("what the panel says about the connection", () => {
  it("answers 'is their board on their website' in one line", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "j.masri";
    const res = await app.inject({ method: "GET", url: "/api/admin/tenants/tnt-yorkfx", cookies: cookie });
    const p = res.json().publicSite;
    expect(p.hosted).toBe(true);
    expect(p.published).toBe(true);
    expect(p.path).toBe("/sites/yorkfx");
    expect(p.ratesEndpoint).toBe("/api/sites/yorkfx/rates");
    expect(p.status).toContain("Live.");
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });
});
