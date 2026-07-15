/* Public storefront APIs — task #11. Contact/hours published from the OS
   hydrate the hosted site, and "Get a live quote" becomes an SMS rate
   hold priced off the same published board the desk runs on. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};
const login = async (staffId: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });

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

describe("published site config", () => {
  it("a manager publishes contact + hours; the public endpoint serves them", async () => {
    const mgr = await login("r.haddad");
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/tenant",
      cookies: cookieOf(mgr),
      payload: { siteConfig: { phone: "647-349-0980", email: "desk@yorkfx.ca", address: "69 Yorkville Ave, Unit 102", city: "Toronto", region: "ON", postal: "M5R 1B8", hours: [{ days: "Mon–Fri", hours: "9:30am–6:00pm" }, { days: "Sat–Sun & holidays", hours: "10:00am–5:00pm" }] } },
    });
    expect(patch.statusCode).toBe(200);

    const pub = await app.inject({ method: "GET", url: "/api/sites/yorkfx/config" });
    expect(pub.statusCode).toBe(200);
    const site = pub.json().site;
    expect(site).toMatchObject({ name: "York FX", slug: "yorkfx", phone: "647-349-0980" });
    expect(site.hours).toHaveLength(2);

    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("tenant.site_config_changed");
  });

  it("a teller cannot publish site config; a manager cannot change plan or domain", async () => {
    const teller = await login("m.costa");
    const denied = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(teller), payload: { siteConfig: { phone: "555" } } });
    expect(denied.statusCode).toBe(403);
    const mgr = await login("r.haddad");
    const deniedPlan = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(mgr), payload: { plan: "basic" } });
    expect(deniedPlan.statusCode).toBe(403);
  });
});

describe("SMS rate holds", () => {
  it("prices a quote off the published board, holds 30 min, and composes the text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sites/yorkfx/quotes",
      payload: { phone: "647 555 0134", from: "CAD", to: "USD", amount: 1000 },
    });
    expect(res.statusCode).toBe(201);
    const q = res.json().quote;
    expect(q.status).toBe("held");
    expect(q.smsStatus).toBe("simulated");
    expect(q.phone).toBe("+16475550134");
    expect(q.expiresAt).toBeGreaterThan(Date.now() + 25 * 60 * 1000);

    // desk math: selling USD at mid*(1+sellMargin) — seed board USD mid & 1.5%
    const board = (await handle.db.select().from(schema.rateBoards))[0]!;
    const expected = 1000 / (board.boardRows.USD!.mid * (1 + board.sellMargin));
    expect(q.receive).toBeCloseTo(expected, 6);

    const row = (await handle.db.select().from(schema.rateQuotes).where(eq(schema.rateQuotes.id, q.ref)))[0]!;
    expect(row.smsText).toContain(q.ref);
    expect(row.smsText).toContain("held for 30 min");
    expect(row.smsText).toContain("Reply STOP to opt out");
  });

  it("confirming a held quote flips it and refuses after expiry", async () => {
    const make = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550177", from: "USD", to: "CAD", amount: 500 } });
    const ref = make.json().quote.ref;
    const ok = await app.inject({ method: "POST", url: `/api/sites/yorkfx/quotes/${ref}/confirm` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().quote.status).toBe("confirmed");

    // force expiry and check both confirm and read-side status
    const make2 = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550178", from: "CAD", to: "EUR", amount: 200 } });
    const ref2 = make2.json().quote.ref;
    await handle.db.update(schema.rateQuotes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.rateQuotes.id, ref2));
    const late = await app.inject({ method: "POST", url: `/api/sites/yorkfx/quotes/${ref2}/confirm` });
    expect(late.statusCode).toBe(410);
  });

  it("brakes abuse: a phone gets three quotes an hour", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550199", from: "CAD", to: "USD", amount: 100 + i } });
      expect(r.statusCode).toBe(201);
    }
    const fourth = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550199", from: "CAD", to: "USD", amount: 999 } });
    expect(fourth.statusCode).toBe(429);
  });

  it("rejects numbers we cannot text and unknown currencies", async () => {
    const badPhone = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "12", from: "CAD", to: "USD", amount: 100 } });
    expect(badPhone.statusCode).toBe(400);
    const badCcy = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550111", from: "CAD", to: "XXX", amount: 100 } });
    expect(badCcy.statusCode).toBe(400);
  });

  it("staff see the desk's incoming holds", async () => {
    const teller = await login("m.costa");
    const res = await app.inject({ method: "GET", url: "/api/quotes", cookies: cookieOf(teller) });
    expect(res.statusCode).toBe(200);
    expect(res.json().quotes.length).toBeGreaterThanOrEqual(5);
    const unauth = await app.inject({ method: "GET", url: "/api/quotes" });
    expect(unauth.statusCode).toBe(401);
  });
});
