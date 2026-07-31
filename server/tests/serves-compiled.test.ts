/* What actually gets served.

   The OS and the panel are written buildless — JSX compiled in the
   visitor's browser — and `npm run build:os` compiles them ahead of time
   into web/app. Which of the two a customer gets is decided here, and it
   is exactly the kind of thing that quietly regresses: somebody adds a
   STATIC_INDEX to a deploy, or the build stops running, and everyone is
   back to waiting on Babel with no error anywhere to say so.
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
  delete process.env.STATIC_INDEX;
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); delete process.env.STATIC_DIR; });

const get = (url: string) => app.inject({ method: "GET", url });

describe("the compiled apps are the ones that ship", () => {
  it("serves the compiled OS at /app", async () => {
    const res = await get("/app");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/web/app/os.js");
  });

  it("serves the compiled panel at /admin", async () => {
    const res = await get("/admin");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/web/app/admin.js");
  });

  /* The three reasons this was worth doing. Each of them is a request a
     customer's browser used to make before the desk would open. */
  for (const [what, url] of [["OS", "/app"], ["panel", "/admin"]] as const) {
    it(`does not send the ${what} to a CDN to boot`, async () => {
      const html = (await get(url)).body;
      expect(html).not.toMatch(/unpkg\.com/);
      /* And no browser-side compiler at all. Matched on the tag rather than
         the word: the page carries a comment saying where Babel went, and
         losing that comment is not the regression worth catching. */
      expect(html).not.toMatch(/<script[^>]*babel/i);
      expect(html).not.toMatch(/type="text\/babel"/);
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
