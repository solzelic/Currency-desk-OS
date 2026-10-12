/* The product clock is the real one. A seam test that has to stand just
   after midnight sends x-cd-now, and only a server started with
   CD_TEST_CLOCK=1, outside production, honours it. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { bindTestClock, now, TEST_CLOCK_PRODUCTION_ERROR } from "../src/ledger/clock.js";

const ORIGINAL = process.env.CD_TEST_CLOCK;
const ORIGINAL_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CD_TEST_CLOCK;
  else process.env.CD_TEST_CLOCK = ORIGINAL;
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
});

async function clockApp() {
  const app = Fastify();
  bindTestClock(app);
  app.get("/now", async () => ({ now: now().toISOString() }));
  return app;
}

describe("test clock", () => {
  it("refuses to boot when the test clock is set in production", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "production",
        CD_TEST_CLOCK: "1",
        DATABASE_URL: "postgres://127.0.0.1:1/unused",
        SEED_PASSWORD: "unused-password",
        PLATFORM_MFA_KEY: "unused-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const [code] = await once(child, "exit");
    clearTimeout(timer);
    expect(code).not.toBe(0);
    expect(output).toContain(TEST_CLOCK_PRODUCTION_ERROR);
  });

  it("ignores x-cd-now in production when the test clock is off, and does not register the hook", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CD_TEST_CLOCK;
    const names: string[] = [];
    bindTestClock({ addHook(name: string) { names.push(name); } } as never);
    expect(names).toEqual([]);
    const app = Fastify();
    bindTestClock(app);
    app.get("/now", async () => ({ now: now().toISOString() }));
    const before = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/now",
      headers: { "x-cd-now": "not-a-time" },
    });
    expect(res.statusCode).toBe(200);
    const at = new Date(res.json().now).getTime();
    expect(Math.abs(at - before)).toBeLessThan(5_000);
    await app.close();
  });

  it("ignores x-cd-now unless the test clock is switched on", async () => {
    delete process.env.CD_TEST_CLOCK;
    const app = await clockApp();
    const before = Date.now();
    const res = await app.inject({
      method: "GET",
      url: "/now",
      headers: { "x-cd-now": "2026-10-12T00:30:00+03:00" },
    });
    expect(res.statusCode).toBe(200);
    const at = new Date(res.json().now).getTime();
    expect(Math.abs(at - before)).toBeLessThan(5_000);
    await app.close();
  });

  it("uses x-cd-now for the rest of the request when the test clock is on", async () => {
    process.env.NODE_ENV = "test";
    process.env.CD_TEST_CLOCK = "1";
    const app = await clockApp();
    const res = await app.inject({
      method: "GET",
      url: "/now",
      headers: { "x-cd-now": "2026-10-12T00:30:00+03:00" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().now).toBe("2026-10-11T21:30:00.000Z");
    await app.close();
  });

  it("render.yaml does not switch the test clock on", () => {
    const yaml = readFileSync(resolve(import.meta.dirname, "../../render.yaml"), "utf8");
    expect(yaml).not.toContain("CD_TEST_CLOCK");
  });

  it("refuses a header that is not a time", async () => {
    process.env.CD_TEST_CLOCK = "1";
    const app = await clockApp();
    const res = await app.inject({
      method: "GET",
      url: "/now",
      headers: { "x-cd-now": "not-a-time" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_REQUEST");
    await app.close();
  });
});
