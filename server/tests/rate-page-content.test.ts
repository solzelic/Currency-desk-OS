/* Rates v2.5, the rate page editor's server side.

   Every shop has a rate page from the day it opens: its own address,
   private until the owner turns it on. The desk fills it in (the
   design's "Your online rate page"): the name and a short line, how to
   reach the shop and its hours by day (kept with the business profile in
   Settings, so both show the same), what the page shows, which
   currencies, and the regulator block, which only the owner changes. The
   owner and staff see the page before it is live, signed in. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forgetPublicAnswers } from "../src/rates/public-board.js";
import { ensureRatePage } from "../src/rates/rate-page.js";

let handle: DbHandle;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};

async function login(staffId: string) {
  if (cookies[staffId]) return cookies[staffId]!;
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (!c) throw new Error(`${staffId} could not sign in: ${res.body}`);
  return (cookies[staffId] = { cdos_session: c.value });
}
const as = async (staffId: string, method: "GET" | "PUT" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url, cookies: await login(staffId), payload });
const pub = (url: string) => app.inject({ method: "GET", url });
const publish = (payload: object) => as("j.masri", "POST", "/api/rates/publish", payload);
const audits = async (action: string) =>
  (await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, action))).map((r) => r.detail);
const SEVEN = ["USD", "EUR", "GBP", "CHF", "AUD", "JPY", "INR"];
const WEEK = [null, [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], [10, 16]];

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(async () => {
  await handle.db.execute(sql`DELETE FROM shop_rate_pages`);
  await handle.db.execute(sql`DELETE FROM audit_events WHERE action LIKE 'rate_page.%'`);
  await handle.db.update(schema.tenants).set({ siteConfig: null }).where(eq(schema.tenants.id, DEMO.tenantId));
  forgetPublicAnswers();
});

describe("every shop has a rate page", () => {
  it("at its own address, private, made the first time the desk asks", async () => {
    const page = await as("m.costa", "GET", "/api/rate-page");
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({ slug: "yorkfx", live: false });
    expect((await pub("/api/public/rate-pages/yorkfx")).statusCode).toBe(404);
  });

  it("takes the next free address when its own is held by another shop, and is made once", async () => {
    await handle.db.insert(schema.tenants).values({ id: "tnt-copy", name: "York FX", siteSlug: "yorkfx" }).onConflictDoNothing();
    await ensureRatePage(handle.db, DEMO.tenantId);
    const other = await ensureRatePage(handle.db, "tnt-copy");
    expect(other.slug).toBe("yorkfx-2");
    expect((await ensureRatePage(handle.db, "tnt-copy")).slug).toBe("yorkfx-2");
    expect((await handle.db.select().from(schema.shopRatePages)).length).toBe(2);
  });

  it("starts with the regulator and registration number the shop opened with", async () => {
    const page = (await as("j.masri", "GET", "/api/rate-page")).json();
    expect(page.content.regulator).toEqual({ name: "FINTRAC", number: "M12345678", officer: "" });
  });
});

describe("the editor", () => {
  it("a manager fills in the page; each change is audited by field", async () => {
    const res = await as("r.haddad", "PATCH", "/api/rate-page/content", {
      name: "York Currency Exchange",
      tagline: "Best rates on Yonge since 2009",
      show: { converter: true, hours: true, compliance: false },
      codes: ["EUR", "USD"],
      profile: { phone: "+1 416 555 0148", address: "128 Steeles Ave W", city: "Toronto", week: WEEK },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().content).toMatchObject({ name: "York Currency Exchange", tagline: "Best rates on Yonge since 2009", codes: ["EUR", "USD"] });
    expect(await audits("rate_page.content")).toEqual([expect.objectContaining({ fields: ["name", "tagline", "show", "codes", "profile"] })]);
  });

  it("keeps the business profile in one place: Settings and the page show the same contact and hours", async () => {
    await handle.db.update(schema.tenants).set({ siteConfig: { email: "desk@example.test", hours: [{ days: "Mon to Fri", hours: "9 to 6" }] } }).where(eq(schema.tenants.id, DEMO.tenantId));
    await as("r.haddad", "PATCH", "/api/rate-page/content", { profile: { phone: "+1 416 555 0148", week: WEEK } });
    const config = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId)))[0]!.siteConfig;
    /* The week replaces the old free-text lines: the storefront now shows
       the lines made from it. */
    expect(config).toMatchObject({ email: "desk@example.test", phone: "+1 416 555 0148", week: WEEK, hours: [{ days: "Mon to Fri", hours: "9:30 am to 6 pm" }, { days: "Saturday", hours: "10 am to 4 pm" }, { days: "Sunday", hours: "Closed" }] });
    /* Settings saving its own fields does not wipe the week. */
    const settings = await as("j.masri", "PATCH", "/api/tenant", { siteConfig: { phone: "+1 416 555 0199" } });
    expect(settings.statusCode, settings.body).toBe(200);
    const after = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId)))[0]!.siteConfig;
    expect(after).toMatchObject({ phone: "+1 416 555 0199", week: WEEK });
  });

  it("only the owner changes the regulator block; a teller changes nothing", async () => {
    const regulator = { name: "FINTRAC", number: "M21-0098765", officer: "Priya Nair" };
    expect((await as("r.haddad", "PATCH", "/api/rate-page/content", { regulator })).statusCode).toBe(403);
    expect((await as("m.costa", "PATCH", "/api/rate-page/content", { tagline: "x" })).statusCode).toBe(403);
    const owner = await as("j.masri", "PATCH", "/api/rate-page/content", { regulator });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().content.regulator).toEqual(regulator);
  });

  it("refuses an hours day that closes before it opens, a week that is not seven days, a bad code, and anything unknown", async () => {
    const bad = [
      { profile: { week: [null, [18, 9.5], null, null, null, null, null] } },
      { profile: { week: [null, [9.5, 18]] } },
      { profile: { week: [null, [9.25, 18], null, null, null, null, null] } },
      { codes: ["usd"] },
      { codes: ["USD", "USD"] },
      { logo: "data:image/png;base64,AAAA" },
      {},
    ];
    for (const body of bad) expect((await as("r.haddad", "PATCH", "/api/rate-page/content", body)).statusCode, JSON.stringify(body)).toBe(400);
  });
});

describe("one set of opening hours", () => {
  /* The week is the source. The storefront's Visit page shows lines of
     text, so whoever saves the week (the rate page editor or Settings)
     also saves the lines it makes, and both public sites agree. */
  const LINES = [
    { days: "Mon to Fri", hours: "9:30 am to 6 pm" },
    { days: "Saturday", hours: "10 am to 4 pm" },
    { days: "Sunday", hours: "Closed" },
  ];
  const config = async () => (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId)))[0]!.siteConfig;

  it("the editor's week writes the storefront's lines too, and the desk is told them", async () => {
    const res = await as("r.haddad", "PATCH", "/api/rate-page/content", { profile: { week: WEEK } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await config()).toMatchObject({ week: WEEK, hours: LINES });
    expect(res.json().profile).toMatchObject({ week: WEEK, hours: LINES });
  });

  it("Settings reads back what was published, so a desk can see a change made on the rate page", async () => {
    await as("r.haddad", "PATCH", "/api/rate-page/content", { profile: { phone: "+1 416 555 0199", week: WEEK } });
    const tenant = (await as("j.masri", "GET", "/api/tenant")).json().tenant;
    expect(tenant.siteConfig).toMatchObject({ phone: "+1 416 555 0199", week: WEEK, hours: LINES, updatedAt: expect.any(String) });
  });

  it("Settings can save the week as well, with the same lines; a bad week is refused", async () => {
    const settings = await as("j.masri", "PATCH", "/api/tenant", { siteConfig: { phone: "+1 416 555 0148", week: WEEK } });
    expect(settings.statusCode, settings.body).toBe(200);
    expect(await config()).toMatchObject({ phone: "+1 416 555 0148", week: WEEK, hours: LINES });
    expect((await as("j.masri", "GET", "/api/rate-page")).json().profile.week).toEqual(WEEK);
    const bad = await as("j.masri", "PATCH", "/api/tenant", { siteConfig: { week: [null, [18, 9], null, null, null, null, null] } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("what the public page is told", () => {
  beforeEach(async () => {
    const rows = Object.fromEntries(SEVEN.map((c) => [c, { mid: 1 }]));
    await publish({ buyMargin: 0.01, sellMargin: 0.01, rows, order: SEVEN });
    await as("j.masri", "PUT", "/api/rate-page", { slug: "yorkfx", live: true });
  });

  it("shows the top six of the board unless the shop picks its own, in its own order", async () => {
    expect((await pub("/api/public/rate-pages/yorkfx")).json().rates.map((r: { code: string }) => r.code)).toEqual(SEVEN.slice(0, 6));
    await as("r.haddad", "PATCH", "/api/rate-page/content", { codes: ["INR", "EUR"] });
    expect((await pub("/api/public/rate-pages/yorkfx")).json().rates.map((r: { code: string }) => r.code)).toEqual(["INR", "EUR"]);
  });

  it("carries the name, line, week, switches and regulator the shop set", async () => {
    await as("r.haddad", "PATCH", "/api/rate-page/content", { name: "York Currency Exchange", tagline: "Since 2009", show: { converter: false, hours: true, compliance: true }, profile: { week: WEEK } });
    await as("j.masri", "PATCH", "/api/rate-page/content", { regulator: { name: "FINTRAC", number: "M21-0098765", officer: "Priya Nair" } });
    const shop = (await pub("/api/public/rate-pages/yorkfx")).json().shop;
    expect(shop).toMatchObject({
      name: "York Currency Exchange", tagline: "Since 2009", week: WEEK,
      show: { converter: false, hours: true, compliance: true },
      regulator: { name: "FINTRAC", number: "M21-0098765", officer: "Priya Nair" },
    });
  });

  it("carries the shop's service fee note, set from its pricing, and drops it when it is cleared", async () => {
    await as("r.haddad", "PATCH", "/api/rate-page/content", { feeNote: "A service fee of 5.00 CAD may apply to each exchange." });
    expect((await pub("/api/public/rate-pages/yorkfx")).json().shop.feeNote).toBe("A service fee of 5.00 CAD may apply to each exchange.");
    expect((await as("r.haddad", "PATCH", "/api/rate-page/content", { feeNote: "x".repeat(161) })).statusCode).toBe(400);
    await as("r.haddad", "PATCH", "/api/rate-page/content", { feeNote: "" });
    expect((await pub("/api/public/rate-pages/yorkfx")).json().shop).not.toHaveProperty("feeNote");
  });

  it("leaves the regulator off until it has a name and a number", async () => {
    await as("j.masri", "PATCH", "/api/rate-page/content", { regulator: { name: "FINTRAC", number: "", officer: "" } });
    expect((await pub("/api/public/rate-pages/yorkfx")).json().shop).not.toHaveProperty("regulator");
  });
});

describe("preview", () => {
  it("shows staff the page before it is live, signed in only, never cached publicly", async () => {
    await as("j.masri", "GET", "/api/rate-page");
    expect((await pub("/api/public/rate-pages/yorkfx")).statusCode).toBe(404);
    const seen = await as("m.costa", "GET", "/api/rate-page/preview");
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().shop.name).toBe("York FX");
    expect(seen.headers["cache-control"]).toMatch(/no-store/);
    expect((await pub("/api/rate-page/preview")).statusCode).toBe(401);
  });
});
