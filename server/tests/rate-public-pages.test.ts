/* Rates v2.5, the public pages: the shop's rate page at /r/<address> and a
   window screen at /s/<token>. Both are plain pages that read the public
   endpoints; neither carries a shop's data in the file. Shop text reaches
   the page as data and is written with textContent, never as HTML. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forgetPublicAnswers } from "../src/rates/public-board.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
let handle: DbHandle;
let app: FastifyInstance;
let owner: Record<string, string> = {};
const PAGES = ["rates-public/rate-page.html", "rates-public/window-screen.html"];

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.STATIC_DIR = ROOT;
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: DEMO.password } });
  owner = { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value };
});
afterAll(async () => { await app.close(); await handle.close(); delete process.env.STATIC_DIR; });
beforeEach(async () => {
  await handle.db.execute(sql`DELETE FROM window_screens`);
  await handle.db.execute(sql`DELETE FROM shop_rate_pages`);
  forgetPublicAnswers();
});

describe("the two pages", () => {
  it("are served at /r/<address> and /s/<token>, whatever the address", async () => {
    for (const [url, marker] of [["/r/any-shop", "data-rate-page"], ["/s/sometokensometokensometoken1234", "data-window-screen"]] as const) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain(marker);
    }
  });

  it("hold no shop data and never write shop text as HTML", () => {
    for (const file of PAGES) {
      const page = readFileSync(path.join(ROOT, file), "utf8");
      expect(page, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(page, file).not.toMatch(/yorkfx|York FX|\bCAD\b/);
      expect(page, file).toContain("/api/public/");
    }
  });
});

describe("what the pages are told about the shop", () => {
  const hours = [{ days: "Mon to Fri", hours: "9:30 am to 6 pm" }];
  beforeEach(async () => {
    await handle.db.update(schema.tenants)
      .set({ siteConfig: { phone: "+1 416 555 0148", address: "128 Steeles Ave W", city: "Toronto", region: "ON", postal: "M2R 3H9", email: "desk@example.test", hours } })
      .where(eq(schema.tenants.id, DEMO.tenantId));
  });

  it("the rate page gets the shop's public contact and hours", async () => {
    await app.inject({ method: "PUT", url: "/api/rate-page", cookies: owner, payload: { slug: "york-test", live: true } });
    const page = (await app.inject({ method: "GET", url: "/api/public/rate-pages/york-test" })).json();
    expect(page.shop.contact).toEqual({ phone: "+1 416 555 0148", address: "128 Steeles Ave W", city: "Toronto", region: "ON", postal: "M2R 3H9", email: "desk@example.test" });
    expect(page.shop.hours).toEqual(hours);
  });

  it("a window screen gets the hours only when it shows them", async () => {
    const make = async (showHours: boolean) => (await app.inject({ method: "POST", url: "/api/window-screens", cookies: owner,
      payload: { name: "Window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours } })).json().token as string;
    const shown = (await app.inject({ method: "GET", url: `/api/public/screens/${await make(true)}` })).json();
    expect(shown.shop.hours).toEqual(hours);
    const hidden = (await app.inject({ method: "GET", url: `/api/public/screens/${await make(false)}` })).json();
    expect(hidden.shop).not.toHaveProperty("hours");
  });
});
