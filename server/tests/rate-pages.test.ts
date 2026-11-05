/* Rates v2.5, server part one: one publish per shop, read by every
   surface the shop's customers see.

   A shop's public rate page is private until its owner turns it on, and it
   only ever shows the latest PUBLISHED board, priced on the server. A
   window screen is reached by an unguessable token, so a TV in the window
   needs no sign-in. Nothing here is tied to one shop or one currency. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forgetPublicAnswers } from "../src/rates/public-board.js";

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

const OTHER = "tnt-other-shop";

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  await handle.db.insert(schema.tenants).values({ id: OTHER, name: "Other Exchange" }).onConflictDoNothing();
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(async () => {
  await handle.db.execute(sql`DELETE FROM window_screens`);
  await handle.db.execute(sql`DELETE FROM shop_rate_pages`);
  await handle.db.update(schema.tenants).set({ suspended: false }).where(eq(schema.tenants.id, DEMO.tenantId));
  forgetPublicAnswers();
});

describe("the public rate page", () => {
  it("is private until the owner turns it on, then shows the shop and its home currency", async () => {
    expect((await pub("/api/public/rate-pages/york-test")).statusCode).toBe(404);
    expect((await as("j.masri", "PUT", "/api/rate-page", { slug: "york-test", live: false })).statusCode).toBe(200);
    expect((await pub("/api/public/rate-pages/york-test")).statusCode).toBe(404);
    const opened = await as("j.masri", "PUT", "/api/rate-page", { live: true });
    expect(opened.json()).toEqual({ slug: "york-test", live: true });
    const page = await pub("/api/public/rate-pages/york-test");
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().shop).toMatchObject({ name: expect.any(String), slug: "york-test", home: "CAD" });
    expect(page.headers["cache-control"]).toBe("public, max-age=60");
  });

  /* The desk's own lines (quotes/terms.ts): we buy at mid x (1 - margin),
     and a customer buying foreign gets (1 - margin) / mid units, so we sell
     at mid / (1 - margin). Not the website's older mid x (1 + margin). */
  it("shows only the latest published board, priced on the server the way the desk charges, in the desk's order", async () => {
    await as("j.masri", "PUT", "/api/rate-page", { slug: "york-test", live: true });
    await publish({ buyMargin: 0.02, sellMargin: 0.03, rows: { USD: { mid: 2 }, EUR: { mid: 1.5, spread: 0.1 }, JPY: { mid: 0.01, show: false } }, order: ["EUR", "USD", "JPY"] });
    const body = (await pub("/api/public/rate-pages/york-test")).json();
    expect(body.rates).toEqual([{ code: "EUR", buy: 1.35, sell: 1.666667 }, { code: "USD", buy: 1.96, sell: 2.061856 }]);
    expect(body.publishedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(body)).not.toMatch(/margin|mid|spread/i);
  });

  it("is named and opened by the owner only, and each change is audited with old and new", async () => {
    for (const staffId of ["r.haddad", "a.singh", "m.costa", "s.iqbal"]) {
      expect((await as(staffId, "PUT", "/api/rate-page", { slug: "york-test", live: true })).statusCode, staffId).toBe(403);
    }
    /* Every shop has a page from the first ask, at its own address, private. */
    expect((await as("m.costa", "GET", "/api/rate-page")).json()).toMatchObject({ slug: "yorkfx", live: false });
    await as("j.masri", "PUT", "/api/rate-page", { slug: "york-test" });
    await as("j.masri", "PUT", "/api/rate-page", { live: true });
    expect((await audits("rate_page.change")).slice(-2)).toEqual([
      { field: "slug", old: "yorkfx", new: "york-test" },
      { field: "live", old: false, new: true },
    ]);
  });

  it("refuses a bad address, an address another shop holds, and going live with no address", async () => {
    expect((await as("j.masri", "PUT", "/api/rate-page", { live: true })).statusCode).toBe(422);
    for (const slug of ["York FX", "-york", "yo", "a".repeat(41), "york_fx"]) {
      expect((await as("j.masri", "PUT", "/api/rate-page", { slug })).statusCode, slug).toBe(400);
    }
    await handle.db.execute(sql`INSERT INTO shop_rate_pages (tenant_id, slug, live) VALUES (${OTHER}, 'taken-name', true)`);
    const clash = await as("j.masri", "PUT", "/api/rate-page", { slug: "taken-name" });
    expect(clash.statusCode).toBe(409);
  });

  it("answers from memory, and a new publish shows at once", async () => {
    await as("j.masri", "PUT", "/api/rate-page", { slug: "york-test", live: true });
    await publish({ buyMargin: 0.01, sellMargin: 0.01, rows: { USD: { mid: 2 } }, order: ["USD"] });
    expect((await pub("/api/public/rate-pages/york-test")).json().rates[0].buy).toBe(1.98);
    // A write behind the server's back is not seen until the memory is cleared.
    await handle.db.execute(sql`UPDATE shop_rate_pages SET live = false`);
    expect((await pub("/api/public/rate-pages/york-test")).statusCode).toBe(200);
    await handle.db.execute(sql`UPDATE shop_rate_pages SET live = true`);
    await publish({ buyMargin: 0.05, sellMargin: 0.05, rows: { USD: { mid: 2 } }, order: ["USD"] });
    expect((await pub("/api/public/rate-pages/york-test")).json().rates[0].buy).toBe(1.9);
  });

  it("carries the shop's own time zone, the publishing branch's, and none rather than a wrong one", async () => {
    /* The page shows when the board was published and whether the shop is
       open. Both are the shop's clock, not the visitor's. */
    await publish({ buyMargin: 0.01, sellMargin: 0.01, rows: { USD: { mid: 1.3 } } });
    const board = (await handle.db.select().from(schema.rateBoards).where(eq(schema.rateBoards.tenantId, DEMO.tenantId))
      .orderBy(sql`published_at desc`).limit(1))[0]!;
    const branch = (await handle.db.select().from(schema.branches).where(eq(schema.branches.id, board.branchId)))[0]!;
    await as("j.masri", "PUT", "/api/rate-page", { slug: "york-test", live: true });
    /* Made directly, not through the desk: the window screen tests below
       count the audit rows the desk writes. */
    const token = "tz-test-token-0123456789abcdefghijk";
    await handle.db.insert(schema.windowScreens).values({ id: "scr_tz_test", tenantId: DEMO.tenantId, name: "Front window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true, token, createdBy: "j.masri" });
    try {
      await handle.db.update(schema.branches).set({ timezone: "Asia/Dubai" }).where(eq(schema.branches.id, branch.id));
      forgetPublicAnswers();
      expect((await pub("/api/public/rate-pages/york-test")).json().shop.timeZone).toBe("Asia/Dubai");
      expect((await pub(`/api/public/screens/${token}`)).json().shop.timeZone).toBe("Asia/Dubai");
      await handle.db.update(schema.branches).set({ timezone: "Not/AZone" }).where(eq(schema.branches.id, branch.id));
      forgetPublicAnswers();
      expect((await pub("/api/public/rate-pages/york-test")).json().shop).not.toHaveProperty("timeZone");
    } finally {
      await handle.db.update(schema.branches).set({ timezone: branch.timezone }).where(eq(schema.branches.id, branch.id));
    }
  });

  it("goes dark when the shop is suspended", async () => {
    await as("j.masri", "PUT", "/api/rate-page", { slug: "york-test", live: true });
    await handle.db.update(schema.tenants).set({ suspended: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    expect((await pub("/api/public/rate-pages/york-test")).statusCode).toBe(404);
  });
});

describe("window screens", () => {
  const screen = { name: "Front window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true };

  it("get an unguessable token, and only staff who may change rates manage them", async () => {
    expect((await as("m.costa", "POST", "/api/window-screens", screen)).statusCode).toBe(403);
    const made = await as("r.haddad", "POST", "/api/window-screens", screen);
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const list = (await as("m.costa", "GET", "/api/window-screens")).json();
    expect(list.screens.map((s: { name: string }) => s.name)).toEqual(["Front window"]);
    expect(await audits("window_screen.create")).toEqual([expect.objectContaining({ screenId: made.json().id })]);
  });

  it("show the published board by token, top six by default, then the picked currencies, until retired", async () => {
    const rows = Object.fromEntries(["USD", "EUR", "GBP", "CHF", "AUD", "JPY", "INR"].map((c) => [c, { mid: 1 }]));
    await publish({ buyMargin: 0.01, sellMargin: 0.01, rows, order: Object.keys(rows) });
    const { id, token } = (await as("j.masri", "POST", "/api/window-screens", screen)).json();
    const shown = await pub(`/api/public/screens/${token}`);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().rates.map((r: { code: string }) => r.code)).toEqual(["USD", "EUR", "GBP", "CHF", "AUD", "JPY"]);
    expect(shown.json().screen).toEqual({ name: "Front window", kind: "tv", layout: "two", theme: "dark", showHours: true, show: { flags: true, names: true, clock: true, logo: true } });
    expect(shown.json().shop).toMatchObject({ name: expect.any(String), home: "CAD" });
    await as("j.masri", "PATCH", `/api/window-screens/${id}`, { currencies: ["INR", "EUR"] });
    expect((await pub(`/api/public/screens/${token}`)).json().rates.map((r: { code: string }) => r.code)).toEqual(["INR", "EUR"]);
    expect((await as("j.masri", "POST", `/api/window-screens/${id}/retire`)).statusCode).toBe(200);
    expect((await pub(`/api/public/screens/${token}`)).statusCode).toBe(404);
    expect((await pub("/api/public/screens/not-a-real-token-but-long-enough-xx")).statusCode).toBe(404);
  });

  it("get a new link on reset, and the old one stops at once", async () => {
    const { id, token } = (await as("r.haddad", "POST", "/api/window-screens", screen)).json();
    expect((await as("m.costa", "POST", `/api/window-screens/${id}/reset`)).statusCode).toBe(403);
    const reset = await as("r.haddad", "POST", `/api/window-screens/${id}/reset`);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(reset.json().token).not.toBe(token);
    expect((await pub(`/api/public/screens/${token}`)).statusCode).toBe(404);
    expect((await pub(`/api/public/screens/${reset.json().token}`)).statusCode).toBe(200);
    expect(await audits("window_screen.reset")).toEqual([{ screenId: id }]);
  });

  it("refuse a change with nothing in it, or a field they do not have", async () => {
    const { id } = (await as("j.masri", "POST", "/api/window-screens", screen)).json();
    expect((await as("j.masri", "PATCH", `/api/window-screens/${id}`, {})).statusCode).toBe(400);
    expect((await as("j.masri", "PATCH", `/api/window-screens/${id}`, { token: "mine-now" })).statusCode).toBe(400);
  });

  it("belong to one shop: another shop's screen cannot be seen or changed", async () => {
    await handle.db.execute(sql`INSERT INTO window_screens (id, tenant_id, name, kind, layout, theme, currencies, show_hours, token)
      VALUES ('scr-other', ${OTHER}, 'Theirs', 'tv', 'one', 'light', '[]'::jsonb, false, 'othertokenothertokenothertoken12')`);
    expect((await as("j.masri", "GET", "/api/window-screens")).json().screens).toEqual([]);
    expect((await as("j.masri", "PATCH", "/api/window-screens/scr-other", { name: "Mine now" })).statusCode).toBe(404);
    expect((await as("j.masri", "POST", "/api/window-screens/scr-other/retire")).statusCode).toBe(404);
  });

  it("go dark when the shop is suspended", async () => {
    const { token } = (await as("j.masri", "POST", "/api/window-screens", screen)).json();
    await handle.db.update(schema.tenants).set({ suspended: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    expect((await pub(`/api/public/screens/${token}`)).statusCode).toBe(404);
  });
});
