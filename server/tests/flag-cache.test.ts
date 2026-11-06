/* A currency's flag is kept for a day.

   The Rates app draws every currency's flag (assets/flags, one small SVG
   each). Served as `public, max-age=0`, the browser fetched all of them
   again each time Rates opened: 22 requests, about 240 ms each from Israel.
   A flag almost never changes, so a day is safe: a changed flag shows by
   the next day, and a new currency's flag is a new file. Only the flag
   images change; anything else is served as before. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
let handle: DbHandle; let app: FastifyInstance;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville";
  process.env.STATIC_DIR = ROOT;
  process.env.STATIC_INDEX = "CurrencyDesk OS.html";
  process.env.SITE_INDEX = "web/index.html";
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
});
afterAll(async () => {
  await app.close(); await handle.close();
  delete process.env.STATIC_DIR; delete process.env.STATIC_INDEX; delete process.env.SITE_INDEX;
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { "sec-fetch-dest": "image" } });

describe("currency flags", () => {
  it("are kept for a day", async () => {
    for (const url of ["/assets/flags/us.svg", "/assets/flags/eu.svg", "/assets/flags/gb.svg"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["cache-control"], url).toBe("public, max-age=86400");
    }
  });

  it("are not kept when the flag is not there", async () => {
    const res = await get("/assets/flags/zz.svg");
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).not.toBe("public, max-age=86400");
  });

  it("leave anything else in the flags folder as it was", async () => {
    const res = await get("/assets/flags/README.md");
    expect(res.headers["cache-control"]).not.toBe("public, max-age=86400");
  });
});
