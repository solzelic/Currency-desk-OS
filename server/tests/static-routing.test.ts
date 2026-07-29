/* What gets served when a path does not exist.

   The fallback answers unknown paths with the marketing site's front page,
   which is right for a deep link somebody typed and wrong for everything
   else. It used to answer that way for ANY GET — so the OS, which shows the
   Rate Board in an iframe, displayed "More trades. Less paperwork." where
   the rate board should have been, with a 200 and no error anywhere. A
   mistyped script path came back as HTML with a 200 on it too.

   These pin both halves: the Rate Board is actually served, and a resource
   that is missing says so instead of quietly becoming a web page. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.STATIC_DIR = REPO;
  process.env.STATIC_INDEX = "CurrencyDesk OS.html";
  process.env.SITE_INDEX = "web/index.html";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => {
  await app.close(); await handle.close();
  delete process.env.STATIC_DIR; delete process.env.STATIC_INDEX; delete process.env.SITE_INDEX;
});

// what the browser sends for each kind of request
const asDocument = { "sec-fetch-dest": "document", accept: "text/html" };
const asScript = { "sec-fetch-dest": "script" };
const asFrame = { "sec-fetch-dest": "iframe", accept: "text/html" };

describe("the Rate Board the OS embeds", () => {
  it("is served, not swapped for the marketing site", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/YorkFX/YorkFX%20Rate%20Board.html?embed=1",
      headers: asFrame,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Rate Board");
    // the tell: the front page's headline turning up inside the product
    expect(res.body).not.toContain("Less paperwork");
  });

  it("serves the storefront pages beside it too", async () => {
    expect((await app.inject({ method: "GET", url: "/YorkFX/yorkfx-rates.css", headers: asScript })).statusCode).toBe(200);
  });
});

describe("a resource that is not there", () => {
  it("is a 404, not a web page with a 200 on it", async () => {
    for (const [url, headers] of [
      ["/os-src/does-not-exist.js", asScript],
      ["/YorkFX/does-not-exist.html", asFrame],
      ["/assets/missing.css", { "sec-fetch-dest": "style" }],
      ["/web/photos/missing.png", { "sec-fetch-dest": "image" }],
    ] as [string, Record<string, string>][]) {
      const res = await app.inject({ method: "GET", url, headers });
      expect({ url, code: res.statusCode }).toEqual({ url, code: 404 });
    }
  });

  it("never hands HTML to something that asked for a script", async () => {
    const res = await app.inject({ method: "GET", url: "/os-src/nope.js", headers: asScript });
    expect(res.body).not.toContain("<!DOCTYPE html>");
  });
});

describe("a page somebody typed", () => {
  it("still lands on the site rather than a 404", async () => {
    const res = await app.inject({ method: "GET", url: "/pricing", headers: asDocument });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<!DOCTYPE html>");
  });

  it("and an unknown path under /app still belongs to the OS", async () => {
    const res = await app.inject({ method: "GET", url: "/app-thing", headers: asDocument });
    expect(res.statusCode).toBe(200);
  });

  /* Older browsers send no Sec-Fetch-Dest. Falling back to Accept keeps deep
     links working for them rather than 404ing a real visitor. */
  it("works for a browser that does not send Sec-Fetch-Dest", async () => {
    expect((await app.inject({ method: "GET", url: "/pricing", headers: { accept: "text/html" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/nope.js", headers: { accept: "*/*" } })).statusCode).toBe(404);
  });

  it("leaves the API alone", async () => {
    expect((await app.inject({ method: "GET", url: "/api/nothing-here", headers: asDocument })).statusCode).toBe(404);
  });
});
