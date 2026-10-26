/* Public health is the probe Render asks. It used to answer `{ ok: true }`
   with no database read, so a Neon outage looked like a live shop until
   a person opened /admin. These pin both sides: 200 when a trivial read
   works, 503 with an unauthenticated-safe body when it does not.

   `/api/admin/health` is a different surface — the narrative dashboard —
   and is not exercised here. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
const savedCommit = process.env.RENDER_GIT_COMMIT;

beforeAll(async () => {
  delete process.env.RENDER_GIT_COMMIT;
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  if (savedCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
  else process.env.RENDER_GIT_COMMIT = savedCommit;
});

describe("GET /api/health", () => {
  it("is 200 when the database answers a trivial read", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      service: "currencydesk-server",
      commit: "unknown",
      lastMigration: null,
    });
  });

  it("is 503 when the database cannot answer, and leaks nothing", async () => {
    const select = vi.spyOn(handle.db, "select").mockImplementation(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432 password=supersecret");
    });
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        ok: false,
        service: "currencydesk-server",
        error: "database",
        commit: "unknown",
        lastMigration: null,
      });
      const body = res.body;
      expect(body).not.toMatch(/ECONNREFUSED|supersecret|password=|5432/i);
    } finally {
      select.mockRestore();
    }
  });

  it("needs no session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });

  it("returns lastMigration null when the migration read never resolves", async () => {
    let release: (value: { rows: [] }) => void = () => {};
    const gate = new Promise<{ rows: [] }>((resolve) => { release = resolve; });
    const execute = vi.spyOn(handle.db, "execute").mockImplementation(() => gate as never);
    const started = Date.now();
    const pending = app.inject({ method: "GET", url: "/api/health" });
    const winner = await Promise.race([
      pending.then((res) => ({ kind: "response" as const, res })),
      new Promise<{ kind: "hung" }>((resolve) => setTimeout(() => resolve({ kind: "hung" }), 1500)),
    ]);
    release({ rows: [] });
    if (winner.kind === "hung") await pending;
    try {
      expect(winner.kind).toBe("response");
      if (winner.kind !== "response") return;
      expect(Date.now() - started).toBeLessThan(1500);
      expect(winner.res.statusCode).toBe(200);
      const body = winner.res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toBe("currencydesk-server");
      expect(body.lastMigration).toBeNull();
    } finally {
      execute.mockRestore();
    }
  });

  it("returns lastMigration null when the pool cannot connect", async () => {
    const session = handle.db as unknown as { session: { client: { connect?: () => Promise<never> } } };
    const client = session.session.client;
    client.connect = () => Promise.reject(new Error("connect refused"));
    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).not.toBe(500);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.lastMigration).toBeNull();
      expect(res.body).not.toMatch(/connect refused/);
    } finally {
      delete client.connect;
    }
  });
});

describe("GET /api/health when the database is gone", () => {
  it("is 503 after the connection is closed", async () => {
    process.env.PGLITE_MEMORY = "1";
    const closed = await createDb();
    const isolated = await buildApp(closed.db);
    await closed.close();
    try {
      const res = await isolated.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        ok: false,
        service: "currencydesk-server",
        error: "database",
        commit: "unknown",
        lastMigration: null,
      });
    } finally {
      await isolated.close();
    }
  });
});
