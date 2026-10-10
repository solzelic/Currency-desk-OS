/* The compiled shells in web/app are what /login, /app and /admin serve.
   The hand-written shells and the JSX under os-src/ are the fallback for
   a deploy that skipped the build, and the source you edit. They are not
   a public URL once the compiled shells are present: a direct fetch must
   be a 404, including a browser navigation, which used to be answered
   with the marketing site.

   One exception, checked below: web/app/index.html still links
   os-src/york-os.css, so that stylesheet stays public or the desk
   loads with a missing stylesheet. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
let handle: DbHandle;
let app: FastifyInstance;

const asDocument = { "sec-fetch-dest": "document", accept: "text/html" };
const asScript = { "sec-fetch-dest": "script", accept: "*/*" };
const asStyle = { "sec-fetch-dest": "style", accept: "text/css" };

/* A real source file the Babel shell loads, and the two shells themselves.
   The stylesheet the compiled page still links is asserted separately. */
const HIDDEN = ["/os-src/cdos-base.jsx", "/CurrencyDesk%20OS.html", "/admin.html"] as const;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.STATIC_DIR = ROOT;
  process.env.STATIC_INDEX = "CurrencyDesk OS.html";
  process.env.SITE_INDEX = "web/index.html";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.STATIC_DIR;
  delete process.env.STATIC_INDEX;
  delete process.env.SITE_INDEX;
});

describe("compiled shells present: the uncompiled desk is not public", () => {
  for (const url of HIDDEN) {
    it(`${url} is a 404, not the file and not the marketing page`, async () => {
      for (const headers of [asScript, asDocument]) {
        const res = await app.inject({ method: "GET", url, headers });
        expect({ url, code: res.statusCode }).toEqual({ url, code: 404 });
        expect(res.body).not.toContain("<!DOCTYPE html>");
        expect(res.body).not.toContain("Less paperwork");
      }
    });
  }

  it("still serves the stylesheet the compiled shell links", async () => {
    const res = await app.inject({ method: "GET", url: "/os-src/york-os.css", headers: asStyle });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("--desk");
  });
});

describe("compiled shells absent: the fallback shells are still served", () => {
  it("returns 200 for the shells and a real os-src file", async () => {
    const tmp = path.join(ROOT, "server", "tmp-uncompiled-desk");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(path.join(tmp, "os-src"), { recursive: true });
    writeFileSync(path.join(tmp, "CurrencyDesk OS.html"), "<html>the uncompiled OS</html>");
    writeFileSync(path.join(tmp, "admin.html"), "<html>the uncompiled panel</html>");
    writeFileSync(path.join(tmp, "os-src", "cdos-base.jsx"), "/* the uncompiled source */");
    writeFileSync(path.join(tmp, "os-src", "york-os.css"), "/* the uncompiled stylesheet */");

    const previous = process.env.STATIC_DIR;
    process.env.STATIC_DIR = tmp;
    const bare = await buildApp(handle.db);
    try {
      const os = await bare.inject({ method: "GET", url: "/CurrencyDesk%20OS.html", headers: asDocument });
      expect(os.statusCode).toBe(200);
      expect(os.body).toContain("the uncompiled OS");

      const admin = await bare.inject({ method: "GET", url: "/admin.html", headers: asDocument });
      expect(admin.statusCode).toBe(200);
      expect(admin.body).toContain("the uncompiled panel");

      const source = await bare.inject({ method: "GET", url: "/os-src/cdos-base.jsx", headers: asScript });
      expect(source.statusCode).toBe(200);
      expect(source.body).toContain("the uncompiled source");

      const css = await bare.inject({ method: "GET", url: "/os-src/york-os.css", headers: asStyle });
      expect(css.statusCode).toBe(200);
      expect(css.body).toContain("the uncompiled stylesheet");
    } finally {
      await bare.close();
      process.env.STATIC_DIR = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
