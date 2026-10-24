/* The reset route is off unless NODE_ENV is test or development, the
   harness asked, and the host node-pg would dial is local. These are
   fake URLs. They do not read the process environment. */
import { build } from "esbuild";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { registerTestDeskReset } from "../src/ledger/test-desk-reset.js";

const local = "postgres://user:fake@127.0.0.1:5432/db";
const allowed = { NODE_ENV: "test", CD_TEST_RESET: "1" };

function fakePool(): pg.Pool {
  return {
    connect() {
      throw new Error("the reset handler ran");
    },
  } as unknown as pg.Pool;
}

async function status(env: NodeJS.ProcessEnv, databaseUrl: string): Promise<number> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerTestDeskReset(app, fakePool(), databaseUrl, env);
  const response = await app.inject({ method: "POST", url: "/api/test/reset-desk" });
  await app.close();
  return response.statusCode;
}

describe("the reset route stays unregistered", () => {
  it("answers 404 in production", async () => {
    expect(await status({ NODE_ENV: "production", CD_TEST_RESET: "1" }, local)).toBe(404);
  });

  it("answers 404 when the flag is off", async () => {
    expect(await status({ NODE_ENV: "test" }, local)).toBe(404);
  });

  it("answers 404 for a remote host", async () => {
    expect(await status(allowed, "postgres://user:fake@dpg-abc.example.com:5432/db")).toBe(404);
  });

  it("answers 404 when ?host= names a remote database", async () => {
    expect(
      await status(allowed, "postgres://user:fake@127.0.0.1:5432/db?host=dpg-abc.example.com"),
    ).toBe(404);
  });

  it("answers 404 when the URL has no host and PGHOST is remote", async () => {
    expect(await status({ ...allowed, PGHOST: "dpg-abc.example.com" }, "postgres://user:fake@/db")).toBe(404);
  });

  it("answers 404 when the URL host is remote even if PGHOST is local", async () => {
    expect(
      await status(
        { ...allowed, PGHOST: "127.0.0.1" },
        "postgres://user:fake@dpg-abc.example.com:5432/db",
      ),
    ).toBe(404);
  });

  it("refuses a NODE_ENV that is neither test nor development", async () => {
    expect(await status({ NODE_ENV: "staging", CD_TEST_RESET: "1" }, local)).toBe(404);
  });
});

describe("the reset route registers only for a local test", () => {
  it("is present for a local URL in test", async () => {
    expect(await status(allowed, local)).not.toBe(404);
  });

  it("is present for localhost and ::1", async () => {
    expect(await status(allowed, "postgres://user:fake@localhost:5432/db")).not.toBe(404);
    expect(await status(allowed, "postgres://user:fake@[::1]:5432/db")).not.toBe(404);
  });

  it("uses PGHOST when the URL names no host", async () => {
    expect(await status({ ...allowed, PGHOST: "localhost" }, "postgres://user:fake@/db")).not.toBe(404);
  });
});

describe("the production bundle does not contain the reset", () => {
  it("bundles src/index.ts without registerTestDeskReset", async () => {
    const result = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ["src/index.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      packages: "external",
      logLevel: "silent",
    });
    const output = result.outputFiles.map((file) => file.text).join("\n");
    expect(output.includes("registerTestDeskReset"), "bundle names registerTestDeskReset").toBe(false);
    expect(output.includes("test-desk-reset"), "bundle names test-desk-reset").toBe(false);
  });
});
