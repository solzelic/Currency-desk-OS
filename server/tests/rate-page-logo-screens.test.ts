/* Rates v2.5: the shop's logo, and the window screen options the design
   has (kinds, rotating pages, what shows on screen).

   A logo is a PNG the desk has already drawn to 240px. The server takes
   PNG only, checked by its signature and size, never SVG (an SVG can
   carry script), and serves it back as an image that cannot run as a
   page. It shows on the rate page and on screens that show it. */
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
const as = async (staffId: string, method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, cookies: await login(staffId), payload });
const pub = (url: string) => app.inject({ method: "GET", url });

/* A real 1x1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png = `data:image/png;base64,${PNG}`;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(async () => {
  await handle.db.execute(sql`DELETE FROM window_screens`);
  await handle.db.execute(sql`DELETE FROM shop_rate_pages`);
  forgetPublicAnswers();
  await as("j.masri", "GET", "/api/rate-page");
  await as("j.masri", "PUT", "/api/rate-page", { slug: "yorkfx", live: true });
});

describe("the logo", () => {
  it("a manager uploads a PNG; the page shows it, served as an image that cannot run", async () => {
    const up = await as("r.haddad", "PUT", "/api/rate-page/logo", { dataUrl: png });
    expect(up.statusCode, up.body).toBe(200);
    const logo = (await pub("/api/public/rate-pages/yorkfx")).json().shop.logo as string;
    expect(logo).toMatch(/^\/api\/public\/rate-pages\/yorkfx\/logo\?v=\d+$/);
    const img = await pub(logo);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(img.rawPayload.equals(Buffer.from(PNG, "base64"))).toBe(true);
    const audit = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "rate_page.logo"));
    expect(audit.map((a) => a.detail)).toEqual([{ set: true, bytes: Buffer.from(PNG, "base64").length }]);
  });

  it("refuses anything but a PNG: SVG, JPEG, a lie about the type, bad base64, too big", async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>").toString("base64")}`;
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString("base64")}`;
    const liar = `data:image/png;base64,${Buffer.from("<html><script>alert(1)</script></html>").toString("base64")}`;
    const huge = `data:image/png;base64,${Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(300_000)]).toString("base64")}`;
    for (const dataUrl of [svg, jpeg, liar, "data:image/png;base64,***", huge]) {
      expect((await as("r.haddad", "PUT", "/api/rate-page/logo", { dataUrl })).statusCode, dataUrl.slice(0, 30)).toBe(400);
    }
  });

  it("a teller cannot change it; removing it takes it off; a private page's logo is not public", async () => {
    expect((await as("m.costa", "PUT", "/api/rate-page/logo", { dataUrl: png })).statusCode).toBe(403);
    await as("r.haddad", "PUT", "/api/rate-page/logo", { dataUrl: png });
    await as("j.masri", "PUT", "/api/rate-page", { live: false });
    expect((await pub("/api/public/rate-pages/yorkfx/logo")).statusCode).toBe(404);
    expect((await as("m.costa", "GET", "/api/rate-page/preview")).json().shop.logo).toMatch(/^\/api\/rate-page\/logo\?v=\d+$/);
    expect((await as("m.costa", "GET", "/api/rate-page/logo")).statusCode).toBe(200);
    expect((await as("r.haddad", "DELETE", "/api/rate-page/logo")).statusCode).toBe(200);
    expect((await as("m.costa", "GET", "/api/rate-page/preview")).json().shop).not.toHaveProperty("logo");
    expect((await as("m.costa", "GET", "/api/rate-page/logo")).statusCode).toBe(404);
  });
});

describe("window screen options", () => {
  const base = { name: "Window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true };

  it("take every kind and layout the design has, and what shows on screen", async () => {
    const made = await as("r.haddad", "POST", "/api/window-screens", { ...base, kind: "strip", layout: "rotate", show: { flags: false, names: true, clock: false, logo: true } });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ kind: "strip", layout: "rotate", show: { flags: false, names: true, clock: false, logo: true } });
    const portrait = await as("r.haddad", "PATCH", `/api/window-screens/${made.json().id}`, { kind: "portrait" });
    expect(portrait.json().kind).toBe("portrait");
    const seen = (await pub(`/api/public/screens/${made.json().token}`)).json();
    expect(seen.screen).toMatchObject({ kind: "portrait", layout: "rotate", show: { flags: false, names: true, clock: false, logo: true } });
    for (const bad of [{ kind: "billboard" }, { layout: "three" }, { show: { sparkles: true } }]) {
      expect((await as("r.haddad", "PATCH", `/api/window-screens/${made.json().id}`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("show everything by default, and the logo only when the shop has one and the screen shows it", async () => {
    const { token, id } = (await as("r.haddad", "POST", "/api/window-screens", base)).json();
    expect((await pub(`/api/public/screens/${token}`)).json().screen.show).toEqual({ flags: true, names: true, clock: true, logo: true });
    expect((await pub(`/api/public/screens/${token}`)).json().shop).not.toHaveProperty("logo");
    await as("r.haddad", "PUT", "/api/rate-page/logo", { dataUrl: png });
    const logo = (await pub(`/api/public/screens/${token}`)).json().shop.logo as string;
    expect(logo).toMatch(new RegExp(`^/api/public/screens/${token}/logo\\?v=\\d+$`));
    expect((await pub(logo)).headers["content-type"]).toBe("image/png");
    await as("r.haddad", "PATCH", `/api/window-screens/${id}`, { show: { logo: false } });
    expect((await pub(`/api/public/screens/${token}`)).json().shop).not.toHaveProperty("logo");
  });

  it("carry the shop's week and regulator for open or closed and the footer", async () => {
    await as("r.haddad", "PATCH", "/api/rate-page/content", { profile: { week: [null, [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], null] } });
    const { token } = (await as("r.haddad", "POST", "/api/window-screens", base)).json();
    const shop = (await pub(`/api/public/screens/${token}`)).json().shop;
    expect(shop.week).toHaveLength(7);
    expect(shop.regulator).toMatchObject({ name: "FINTRAC", number: "M12345678" });
  });
});
