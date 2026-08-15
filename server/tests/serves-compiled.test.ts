/* What actually gets served.

   The OS and the panel are written buildless — JSX compiled in the
   visitor's browser — and `npm run build:os` compiles them ahead of time
   into web/app. Which of the two a customer gets is decided here, and it
   is exactly the kind of thing that quietly regresses: somebody adds a
   STATIC_INDEX to a deploy, or the build stops running, and everyone is
   back to waiting on Babel with no error anywhere to say so.

   These tests use the Render shape: STATIC_INDEX names the uncompiled
   shell. Compiled output must still win. Deleting the variable to make
   the assertion pass is how production kept serving Babel.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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

const get = (url: string) => app.inject({ method: "GET", url });

function assertNoCdnCompiler(html: string) {
  expect(html).not.toMatch(/unpkg\.com/);
  expect(html).not.toMatch(/react\.development/);
  /* Matched on the tag rather than the word: a comment saying where Babel
     went is not the regression worth catching. */
  expect(html).not.toMatch(/<script[^>]*babel/i);
  expect(html).not.toMatch(/type="text\/babel"/);
}

describe("the compiled apps are the ones that ship", () => {
  for (const url of ["/app", "/login"] as const) {
    it(`serves the compiled OS at ${url} even when STATIC_INDEX names the shell`, async () => {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("/web/app/os.js");
      expect(res.body).not.toContain("CurrencyDesk OS.html");
    });
  }

  it("serves the compiled panel at /admin", async () => {
    const res = await get("/admin");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/web/app/admin.js");
  });

  /* The three reasons this was worth doing. Each of them is a request a
     customer's browser used to make before the desk would open. */
  for (const [what, url] of [["OS", "/app"], ["sign-in", "/login"], ["panel", "/admin"]] as const) {
    it(`does not send the ${what} to a CDN to boot`, async () => {
      assertNoCdnCompiler((await get(url)).body);
    });
  }

  it("serves the compiled bundles themselves", async () => {
    for (const f of ["/web/app/os.js", "/web/app/admin.js"]) {
      const res = await get(f);
      expect(res.statusCode, f).toBe(200);
      expect(res.body.length).toBeGreaterThan(50_000);
    }
  });

  it("serves React from our own domain rather than somebody else's", async () => {
    expect((await get("/web/vendor/react.production.min.js")).statusCode).toBe(200);
    expect((await get("/web/vendor/react-dom.production.min.js")).statusCode).toBe(200);
  });
});

/* The storefront is a live customer's site. Design-time tweaks used to
   pull React development builds and Babel from unpkg on every visit. */
describe("the YorkFX storefront does not load a CDN compiler", () => {
  const pages = [
    "/sites/yorkfx/",
    "/sites/yorkfx/YorkFX%20Homepage.html",
    "/sites/yorkfx/YorkFX%20Rates.html",
    "/sites/yorkfx/YorkFX%20Regulations.html",
    "/sites/yorkfx/YorkFX%20Services.html",
    "/sites/yorkfx/YorkFX%20Visit.html",
    "/YorkFX/YorkFX%20Homepage.html",
    "/YorkFX/YorkFX%20Rate%20Board.html",
  ];

  for (const url of pages) {
    it(`${url} has no unpkg, Babel, or react.development`, async () => {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      assertNoCdnCompiler(res.body);
    });
  }

  it("does not ask for the design-tool image-slot sidecar", async () => {
    const res = await get("/sites/yorkfx/image-slot.js");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/loadP = fetch\(STATE_FILE\)/);
    expect(res.body).toContain("no sidecar in production");
  });
});

/* A deploy that has not run the build still has to work — it just serves
   the slow ones rather than nothing at all. */
describe("when the build has not been run", () => {
  it("falls back to the hand-written sources", async () => {
    const tmp = path.join(ROOT, "server", "tmp-static-test");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "CurrencyDesk OS.html"), "<html>the uncompiled OS</html>");
    writeFileSync(path.join(tmp, "admin.html"), "<html>the uncompiled panel</html>");
    expect(existsSync(path.join(tmp, "web", "app"))).toBe(false);

    process.env.STATIC_DIR = tmp;
    const bare = await buildApp(handle.db);
    try {
      expect((await bare.inject({ method: "GET", url: "/app" })).body).toContain("the uncompiled OS");
      expect((await bare.inject({ method: "GET", url: "/admin" })).body).toContain("the uncompiled panel");
    } finally {
      await bare.close();
      process.env.STATIC_DIR = ROOT;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
