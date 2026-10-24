/* The desk reset exists for the seam harness. A production boot, a
   staged boot, and a boot that was not asked must not register it,
   and a remote database must not be a target even if the flag is set. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { testDeskResetEnabled } from "../src/ledger/test-desk-reset.js";

const local = "postgres://postgres:postgres@127.0.0.1:5432/currencydesk_seam";

describe("the seam desk reset stays off unless the harness asks", () => {
  it("accepts a local database when the test flag is set", () => {
    expect(testDeskResetEnabled({ CD_TEST_RESET: "1" }, local)).toBe(true);
    expect(testDeskResetEnabled({ CD_TEST_RESET: "1" }, "postgres://postgres@localhost:5432/db")).toBe(true);
    expect(testDeskResetEnabled({ CD_TEST_RESET: "1" }, "postgres://postgres@[::1]:5432/db")).toBe(true);
  });

  it("refuses production, staging, a missing flag, and a remote host", () => {
    expect(testDeskResetEnabled({ NODE_ENV: "production", CD_TEST_RESET: "1" }, local)).toBe(false);
    expect(testDeskResetEnabled({ STAGING: "true", CD_TEST_RESET: "1" }, local)).toBe(false);
    expect(testDeskResetEnabled({}, local)).toBe(false);
    expect(testDeskResetEnabled({ CD_TEST_RESET: "1" }, "")).toBe(false);
    expect(testDeskResetEnabled({ CD_TEST_RESET: "1" }, "not a url")).toBe(false);
    expect(
      testDeskResetEnabled(
        { CD_TEST_RESET: "1" },
        "postgres://user:pw@dpg-abc.oregon-postgres.render.com:5432/currencydesk",
      ),
    ).toBe(false);
  });
});

describe("the default server does not expose the reset", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  const previous = process.env.CD_TEST_RESET;

  beforeAll(async () => {
    process.env.CD_TEST_RESET = "1";
    handle = await createDb();
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.CD_TEST_RESET;
    else process.env.CD_TEST_RESET = previous;
    await app.close();
    await handle.close();
  });

  it("answers 404 when the ledger pool is not configured", async () => {
    const response = await app.inject({ method: "POST", url: "/api/test/reset-desk" });
    expect(response.statusCode).toBe(404);
  });
});
