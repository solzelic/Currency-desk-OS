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
import http from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
let handle: DbHandle;
let app: FastifyInstance;
let port = 0;

const asDocument = { "sec-fetch-dest": "document", accept: "text/html" };
const asScript = { "sec-fetch-dest": "script", accept: "*/*" };
const asStyle = { "sec-fetch-dest": "style", accept: "text/css" };

/* A real source file the Babel shell loads, and the two shells themselves.
   The stylesheet the compiled page still links is asserted separately. */
const HIDDEN = ["/os-src/cdos-base.jsx", "/CurrencyDesk%20OS.html", "/admin.html", "/shared/id-document-types.js", "/shared/counter-cash.js", "/shared/rolling-24h.js", "/shared/lctr-reversal.js"] as const;

/* Markers that only the uncompiled desk carries. A 200 from the marketing
   page is not a leak; a body with any of these is the source. */
const SOURCE_MARKERS = [
  "text/babel",
  "window.CDOS",
  "CurrencyDesk OS — base layer",
  "@babel/standalone",
] as const;

/* Encoded and lookalike paths. Shells are present, so none of these may
   come back as the JSX or either uncompiled shell. */
const VARIANTS = [
  "/os-src%2Fcdos-base.jsx",
  "/OS-SRC/cdos-base.jsx",
  "/Admin.html",
  "/CurrencyDesk%2520OS.html",
  "//os-src/cdos-base.jsx",
  "/./os-src/cdos-base.jsx",
  "/os-src/cdos-base.jsx/",
  "/web/../os-src/cdos-base.jsx",
  "/os-src/york-os.css/../cdos-base.jsx",
] as const;

const UNCOMPILED_FILES: Record<string, string> = {
  "CurrencyDesk OS.html": "<html>the uncompiled OS</html>",
  "admin.html": "<html>the uncompiled panel</html>",
  "os-src/cdos-base.jsx": "/* the uncompiled source */",
  "os-src/york-os.css": "/* the uncompiled stylesheet */",
  "shared/id-document-types.js": "/* the uncompiled catalogue */",
  "shared/counter-cash.js": "/* the uncompiled cash rule */",
  "shared/rolling-24h.js": "/* the uncompiled lookback */",
  "shared/lctr-reversal.js": "/* the uncompiled reversal rule */",
  "shared/not-listed.js": "/* not on the allow-list */",
};

const MISSING_OS =
  "web/app/index.html is missing; the uncompiled shell and os-src are being served publicly";
const MISSING_ADMIN =
  "web/app/admin.html is missing; the uncompiled admin shell is being served publicly";

function expectNotSource(body: string) {
  for (const marker of SOURCE_MARKERS) {
    expect(body).not.toContain(marker);
  }
}

function writeTree(dir: string, files: Record<string, string>) {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

function logSink(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

/* Raw request line, not app.inject. The injector parses the URL first, and
   that collapses //, /./ and ../ before the server ever sees them. */
function rawGet(
  requestPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: requestPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/* Boot against a planted static dir.
   "production" | "test" | "unset" turns the Fastify logger on into the
   returned text and sets NODE_ENV to that value (delete it for "unset"),
   so a test can read app.log. Omitted, the runner's NODE_ENV stays and
   the logger stays off. */
async function withDesk(
  files: Record<string, string>,
  run: (desk: FastifyInstance) => Promise<void>,
  env?: "production" | "test" | "unset",
): Promise<string> {
  const tmp = path.join(ROOT, "server", "tmp-uncompiled-desk");
  writeTree(tmp, files);
  const previousDir = process.env.STATIC_DIR;
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, "NODE_ENV");
  const previousEnv = process.env.NODE_ENV;
  const sink = logSink();
  process.env.STATIC_DIR = tmp;
  if (env === "production") process.env.NODE_ENV = "production";
  else if (env === "test") process.env.NODE_ENV = "test";
  else if (env === "unset") delete process.env.NODE_ENV;
  let desk: FastifyInstance | undefined;
  try {
    desk = await buildApp(handle.db, {}, env ? sink.stream : undefined);
    await run(desk);
    return sink.text();
  } finally {
    if (desk) await desk.close();
    process.env.STATIC_DIR = previousDir;
    if (hadEnv) process.env.NODE_ENV = previousEnv;
    else delete process.env.NODE_ENV;
    rmSync(tmp, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.STATIC_DIR = ROOT;
  process.env.STATIC_INDEX = "CurrencyDesk OS.html";
  process.env.SITE_INDEX = "web/index.html";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address && typeof address === "object") port = address.port;
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
    await withDesk(UNCOMPILED_FILES, async (bare) => {
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

      /* The uncompiled shell loads the ID-type catalogue, the cash-leg
         rule, the rolling 24 hours, and the LCTR reversal rule.
         Nothing else under shared/ is public. */
      const catalogue = await bare.inject({ method: "GET", url: "/shared/id-document-types.js", headers: asScript });
      expect(catalogue.statusCode).toBe(200);
      expect(catalogue.body).toContain("the uncompiled catalogue");
      const cashRule = await bare.inject({ method: "GET", url: "/shared/counter-cash.js", headers: asScript });
      expect(cashRule.statusCode).toBe(200);
      expect(cashRule.body).toContain("the uncompiled cash rule");
      const lookback = await bare.inject({ method: "GET", url: "/shared/rolling-24h.js", headers: asScript });
      expect(lookback.statusCode).toBe(200);
      expect(lookback.body).toContain("the uncompiled lookback");
      const reversalRule = await bare.inject({ method: "GET", url: "/shared/lctr-reversal.js", headers: asScript });
      expect(reversalRule.statusCode).toBe(200);
      expect(reversalRule.body).toContain("the uncompiled reversal rule");
      const other = await bare.inject({ method: "GET", url: "/shared/not-listed.js", headers: asScript });
      expect(other.statusCode).toBe(404);
      expect(other.body).not.toContain("not on the allow-list");
    });
  });
});

describe("path tricks do not return the uncompiled source", () => {
  for (const url of VARIANTS) {
    it(`${url} is not the source, as a script or a page`, async () => {
      for (const headers of [asScript, asDocument]) {
        const res = await rawGet(url, headers);
        expectNotSource(res.body);
        expect(res.body).not.toContain("os-src/cdos-base.jsx");
      }
    });
  }
});

describe("a half-built web/app hides only the shell that was built", () => {
  it("OS shell only: os-src and the OS html are 404, admin.html is still the fallback", async () => {
    await withDesk(
      { ...UNCOMPILED_FILES, "web/app/index.html": "<html>compiled os</html>" },
      async (bare) => {
        const source = await bare.inject({ method: "GET", url: "/os-src/cdos-base.jsx", headers: asScript });
        expect(source.statusCode).toBe(404);
        expect(source.body).not.toContain("the uncompiled source");

        const os = await bare.inject({ method: "GET", url: "/CurrencyDesk%20OS.html", headers: asDocument });
        expect(os.statusCode).toBe(404);
        expect(os.body).not.toContain("the uncompiled OS");

        const admin = await bare.inject({ method: "GET", url: "/admin.html", headers: asDocument });
        expect(admin.statusCode).toBe(200);
        expect(admin.body).toContain("the uncompiled panel");
      },
    );
  });

  it("admin shell only: admin.html is 404, the OS shell and os-src are still served", async () => {
    await withDesk(
      { ...UNCOMPILED_FILES, "web/app/admin.html": "<html>compiled admin</html>" },
      async (bare) => {
        const admin = await bare.inject({ method: "GET", url: "/admin.html", headers: asDocument });
        expect(admin.statusCode).toBe(404);
        expect(admin.body).not.toContain("the uncompiled panel");

        const os = await bare.inject({ method: "GET", url: "/CurrencyDesk%20OS.html", headers: asDocument });
        expect(os.statusCode).toBe(200);
        expect(os.body).toContain("the uncompiled OS");

        const source = await bare.inject({ method: "GET", url: "/os-src/cdos-base.jsx", headers: asScript });
        expect(source.statusCode).toBe(200);
        expect(source.body).toContain("the uncompiled source");
      },
    );
  });
});

describe("a missing compiled shell warns in production", () => {
  it("names each missing shell for what that shell exposes", async () => {
    const logs = await withDesk(UNCOMPILED_FILES, async () => {}, "production");
    expect(logs).toContain(MISSING_OS);
    expect(logs).toContain(MISSING_ADMIN);
    const adminLine = logs.split("\n").find((line) => line.includes("web/app/admin.html"));
    expect(adminLine).toBeTruthy();
    expect(adminLine).not.toContain("os-src");
  });

  it("does not say os-src is public when only the admin shell is missing", async () => {
    const logs = await withDesk(
      { ...UNCOMPILED_FILES, "web/app/index.html": "<html>compiled os</html>" },
      async () => {},
      "production",
    );
    expect(logs).not.toContain(MISSING_OS);
    expect(logs).toContain(MISSING_ADMIN);
    expect(logs).not.toContain("os-src");
  });

  it("names the uncompiled shell and os-src when only the OS shell is missing", async () => {
    const logs = await withDesk(
      { ...UNCOMPILED_FILES, "web/app/admin.html": "<html>compiled admin</html>" },
      async () => {},
      "production",
    );
    expect(logs).toContain(MISSING_OS);
    expect(logs).not.toContain("web/app/admin.html");
    expect(logs).not.toContain("uncompiled admin shell");
  });

  it.each(["test", "unset"] as const)("does not warn when NODE_ENV is %s", async (env) => {
    const logs = await withDesk(UNCOMPILED_FILES, async () => {}, env);
    expect(logs).not.toContain("is missing");
    expect(logs).not.toContain("being served publicly");
  });

  it("stays quiet when both compiled shells are present", async () => {
    const previousDir = process.env.STATIC_DIR;
    const previousEnv = process.env.NODE_ENV;
    const sink = logSink();
    process.env.STATIC_DIR = ROOT;
    process.env.NODE_ENV = "production";
    let desk: FastifyInstance | undefined;
    try {
      desk = await buildApp(handle.db, {}, sink.stream);
      expect(sink.text()).not.toContain(MISSING_OS);
      expect(sink.text()).not.toContain(MISSING_ADMIN);
      expect(sink.text()).not.toContain("being served publicly");
    } finally {
      if (desk) await desk.close();
      process.env.STATIC_DIR = previousDir;
      process.env.NODE_ENV = previousEnv;
    }
  });
});
