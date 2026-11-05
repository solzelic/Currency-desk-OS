/* Who may show our pages inside theirs.

   Nothing said, so any site could put the desk in a frame and dress it up
   (clickjacking). Now every page we serve says: only CurrencyDesk may frame
   it. The one exception is a shop's public rate page, /r/<address>: Rates
   v2.5's "Take it further" lets a shop show its rates inside its own
   website, and that page holds nothing but published rates. A header a
   route already set (the logo's sandbox) is left as it is. */
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
const asDocument = { "sec-fetch-dest": "document", accept: "text/html" };

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

const get = (url: string) => app.inject({ method: "GET", url, headers: asDocument });

describe("framing", () => {
  it("the desk, the front page and a window screen may be framed by CurrencyDesk only", async () => {
    for (const url of ["/app", "/", "/s/abcdefghijklmnopqrstuvwxyz012345"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(String(res.headers["content-type"]), url).toContain("text/html");
      expect(res.headers["content-security-policy"], url).toBe("frame-ancestors 'self'");
      expect(res.headers["x-frame-options"], url).toBe("SAMEORIGIN");
    }
  });

  it("a shop's public rate page may be framed by any site, for Take it further", async () => {
    const res = await get("/r/york-fx");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors *");
    expect(res.headers["x-frame-options"]).toBeUndefined();
  });

  it("leaves a policy a route set itself, and JSON answers alone", async () => {
    const api = await app.inject({ method: "GET", url: "/api/health" });
    expect(api.headers["content-security-policy"]).toBeUndefined();
    expect(api.headers["x-frame-options"]).toBeUndefined();
  });
});
