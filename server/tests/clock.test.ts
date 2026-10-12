/* The product clock is the real one. A seam test that has to stand just
   after midnight sends x-cd-now, and only a server started with
   CD_TEST_CLOCK=1, outside production and outside Render, honours it. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { bindTestClock, now, TEST_CLOCK_PRODUCTION_ERROR } from "../src/ledger/clock.js";

const ORIGINAL = process.env.CD_TEST_CLOCK;
const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_RENDER = process.env.RENDER;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CD_TEST_CLOCK;
  else process.env.CD_TEST_CLOCK = ORIGINAL;
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
  if (ORIGINAL_RENDER === undefined) delete process.env.RENDER;
  else process.env.RENDER = ORIGINAL_RENDER;
});

function bootEnv(extra: Record<string, string | undefined>) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CD_TEST_CLOCK: "1",
    DATABASE_URL: "postgres://127.0.0.1:1/unused",
    SEED_PASSWORD: "unused-password",
    PLATFORM_MFA_KEY: "unused-key",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function expectBootRefused(extra: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: bootEnv(extra),
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
  expect(output).not.toContain("listening");
}

async function clockApp() {
  const app = Fastify();
  bindTestClock(app);
  app.get("/now", async () => ({ now: now().toISOString() }));
  return app;
}

describe("test clock", () => {
  it("refuses to boot when the test clock is set in production", async () => {
    await expectBootRefused({ NODE_ENV: "production" });
  });

  it("refuses to boot when the test clock is set on Render, even with NODE_ENV unset", async () => {
    delete process.env.NODE_ENV;
    await expectBootRefused({ RENDER: "true" });
  });

  it("leaves a Render process alone when the test clock is off", () => {
    process.env.RENDER = "true";
    delete process.env.NODE_ENV;
    delete process.env.CD_TEST_CLOCK;
    const names: string[] = [];
    expect(() => bindTestClock({ addHook(name: string) { names.push(name); } } as never)).not.toThrow();
    expect(names).toEqual([]);
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
