/* A repeat visit to the desk asks the network for the page, not its files.

   Every file the desk loads (os.js, React, the stylesheets, the converter)
   used to come back with `public, max-age=0`, so each visit asked the
   server about each one again. From Israel to staging that is a round trip
   of about 240 ms per file, seven files, before the desk could open, and
   every answer was "not modified".

   Now the built shells name each file with its own content version
   (`?v=` and the first 12 hex characters of its sha256). The server
   answers a file asked for with its own version as cacheable for a year
   and immutable, so the browser does not ask again. The shell itself is
   `no-cache`: it is asked for on every visit, so a deploy shows at once,
   and a new build names new versions.

   These run in the Render shape (STATIC_INDEX names the uncompiled shell,
   compiled output wins), like serves-compiled.test.ts. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const YEAR = "public, max-age=31536000, immutable";

/* Every script and stylesheet a shell loads from our own origin. The
   shells are served at /app, /login and /admin, one segment deep, so a
   relative name is the same file from the root. */
function ownFiles(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) out.push(m[1]!);
  for (const m of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)) out.push(m[1]!);
  return out
    .filter((u) => !/^(?:https?:)?\/\//.test(u))
    .map((u) => (u.startsWith("/") ? u : `/${u}`));
}

const sha12 = (rel: string) =>
  createHash("sha256").update(readFileSync(path.join(ROOT, rel))).digest("hex").slice(0, 12);

describe("the desk's files are cached until they change", () => {
  for (const [shell, url, count] of [["OS", "/app", 7], ["sign-in", "/login", 7], ["panel", "/admin", 3]] as const) {
    it(`asks for the ${shell} shell on every visit`, async () => {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it(`names every file the ${shell} shell loads with that file's own version`, async () => {
      const files = ownFiles((await get(url)).body);
      expect(files).toHaveLength(count);
      for (const file of files) {
        const m = /^\/([^?]+)\?v=([0-9a-f]{12})$/.exec(file);
        expect(m, file).not.toBeNull();
        expect(m![2], file).toBe(sha12(m![1]!));
      }
    });

    it(`serves each file the ${shell} shell names as cacheable for a year`, async () => {
      for (const file of ownFiles((await get(url)).body)) {
        const res = await get(file);
        expect(res.statusCode, file).toBe(200);
        expect(res.headers["cache-control"], file).toBe(YEAR);
      }
    });
  }

  /* An old page can ask for a version the server no longer has: a tab
     opened before a deploy. It gets today's file, which must not be kept
     for a year under the old name. */
  it("does not keep a file for a year under a version that is not its own", async () => {
    const res = await get("/web/app/os.js?v=000000000000");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=0");
  });

  it("caches a file asked for without a version as before", async () => {
    for (const file of ["/web/app/os.js", "/web/vendor/react.production.min.js", "/yorkfx-converter.js", "/yorkfx.css"]) {
      const res = await get(file);
      expect(res.statusCode, file).toBe(200);
      expect(res.headers["cache-control"], file).toBe("public, max-age=0");
    }
  });

  /* The storefront loads the same converter and stylesheet without a
     version. A customer's site keeps its own caching. */
  it("leaves the storefront's copies as they were", async () => {
    for (const file of ["/sites/yorkfx-converter.js", "/sites/yorkfx.css"]) {
      const res = await get(file);
      expect(res.statusCode, file).toBe(200);
      expect(res.headers["cache-control"], file).toBe("public, max-age=0");
    }
  });
});
