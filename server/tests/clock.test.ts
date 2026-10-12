/* The product clock is the real one. A seam test that has to stand just
   after midnight sends x-cd-now, and only a server started with
   CD_TEST_CLOCK=1 honours it. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { bindTestClock, now } from "../src/ledger/clock.js";

const ORIGINAL = process.env.CD_TEST_CLOCK;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CD_TEST_CLOCK;
  else process.env.CD_TEST_CLOCK = ORIGINAL;
});

async function clockApp() {
  const app = Fastify();
  bindTestClock(app);
  app.get("/now", async () => ({ now: now().toISOString() }));
  return app;
}

describe("test clock", () => {
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
