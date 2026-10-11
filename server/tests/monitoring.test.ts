/* With no DSN the public probe stays the body uptime monitors already
   parse, and nothing loads a Sentry client. With a fake DSN the SDK's
   own transport is replaced, so a thrown 500 is captured and the
   request's name, id, amount, cookie, and authorization never leave
   the process. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransport, flush, getClient } from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import {
  sentryIntegrations,
  useTestTransport,
} from "../src/monitoring/sentry.js";
import { CLIENT_ERROR_LIMIT, DEEP_HEALTH_LIMIT, resetRateLimits } from "../src/monitoring/routes.js";

const FAKE_DSN = "https://public@sentry.invalid/1";
const COMMIT = "0123456789abcdef";
const CUSTOMER = "Priya Nair";
const ID_NUMBER = "PA998877";
const AMOUNT = "15000.00";
const TOKEN = "desk-secret-token";
const COOKIE = "cd_session=abc123session";

let quiet: DbHandle;
let quietApp: FastifyInstance;

beforeAll(async () => {
  delete process.env.SENTRY_DSN;
  process.env.PGLITE_MEMORY = "1";
  quiet = await createDb();
  quietApp = await buildApp(quiet.db);
  quietApp.post("/api/__monitoring_probe", async (request) => {
    const body = request.body as { customerName?: string; idNumber?: string; amount?: string };
    throw new Error(`could not post ${body.customerName} ${body.idNumber} ${body.amount}`);
  });
});

afterAll(async () => {
  await quietApp.close();
  await quiet.close();
});

beforeEach(() => {
  resetRateLimits();
});

describe("monitoring with no DSN", () => {
  it("leaves GET /api/health as the probe it already was", async () => {
    const res = await quietApp.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "currencydesk-server" });
    expect(getClient()).toBeUndefined();
  });

  it("answers a database round trip, the migration count, and the commit", async () => {
    delete process.env.RENDER_GIT_COMMIT;
    const res = await quietApp.inject({ method: "GET", url: "/api/health/deep" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["commit", "migrations", "ok", "service", "version"]);
    expect(body).toMatchObject({ ok: true, service: "currencydesk-server", migrations: null, version: "0.1.0", commit: null });
    expect(JSON.stringify(body)).not.toMatch(/postgres:|sentry|password|secret|dsn/i);
  });

  it("reports the git SHA when Render provided one", async () => {
    process.env.RENDER_GIT_COMMIT = COMMIT;
    try {
      const res = await quietApp.inject({ method: "GET", url: "/api/health/deep" });
      expect(res.statusCode).toBe(200);
      expect(res.json().commit).toBe(COMMIT);
    } finally {
      delete process.env.RENDER_GIT_COMMIT;
    }
  });

  it("is 503 when the database cannot answer, and leaks nothing", async () => {
    const select = vi.spyOn(quiet.db, "select").mockImplementation(() => {
      throw new Error("connect ECONNREFUSED password=supersecret");
    });
    try {
      const res = await quietApp.inject({ method: "GET", url: "/api/health/deep" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ok: false, service: "currencydesk-server", error: "database" });
      expect(res.body).not.toMatch(/supersecret|ECONNREFUSED|password=/i);
    } finally {
      select.mockRestore();
    }
  });

  it("rate-limits the deep check", async () => {
    for (let i = 0; i < DEEP_HEALTH_LIMIT; i++) {
      const ok = await quietApp.inject({ method: "GET", url: "/api/health/deep" });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await quietApp.inject({ method: "GET", url: "/api/health/deep" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ ok: false, error: "rate_limited" });
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("logs one structured line for a scrubbed browser report", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const res = await quietApp.inject({
        method: "POST",
        url: "/api/client-errors",
        payload: { message: "till failed to open", stack: "Error: till failed to open", version: "0.1.0", route: "/app" },
      });
      expect(res.statusCode).toBe(204);
      const lines = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("\"event\":\"client-error\""));
      expect(lines).toEqual([
        JSON.stringify({ event: "client-error", message: "till failed to open", route: "/app", version: "0.1.0", stack: "Error: till failed to open" }),
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it("rejects an invalid report and does not log it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const extra = await quietApp.inject({
        method: "POST",
        url: "/api/client-errors",
        payload: { message: "boom", amount: AMOUNT, customerName: CUSTOMER },
      });
      expect(extra.statusCode).toBe(400);
      expect(extra.json()).toEqual({ error: "invalid_report" });
      expect(extra.body).not.toContain(AMOUNT);
      expect(extra.body).not.toContain(CUSTOMER);
      const missing = await quietApp.inject({ method: "POST", url: "/api/client-errors", payload: {} });
      expect(missing.statusCode).toBe(400);
      const logged = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("client-error"));
      expect(logged).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  it("rejects an oversized body", async () => {
    const res = await quietApp.inject({
      method: "POST",
      url: "/api/client-errors",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ message: "x".repeat(5000) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it("rate-limits client reports", async () => {
    for (let i = 0; i < CLIENT_ERROR_LIMIT; i++) {
      const ok = await quietApp.inject({
        method: "POST",
        url: "/api/client-errors",
        payload: { message: "till failed to open" },
      });
      expect(ok.statusCode).toBe(204);
    }
    const blocked = await quietApp.inject({
      method: "POST",
      url: "/api/client-errors",
      payload: { message: "till failed to open" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "rate_limited" });
  });
});

describe("monitoring with a fake DSN", () => {
  const envelopes: string[] = [];
  let app: FastifyInstance;
  let handle: DbHandle;
  const previousDsn = process.env.SENTRY_DSN;
  const previousCommit = process.env.RENDER_GIT_COMMIT;
  const previousEnvironment = process.env.SENTRY_ENVIRONMENT;

  beforeAll(async () => {
    useTestTransport((options) => createTransport(options, (request) => {
      envelopes.push(typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8"));
      return Promise.resolve({ statusCode: 200 });
    }));
    process.env.SENTRY_DSN = FAKE_DSN;
    process.env.RENDER_GIT_COMMIT = COMMIT;
    process.env.SENTRY_ENVIRONMENT = "ci";
    process.env.PGLITE_MEMORY = "1";
    handle = await createDb();
    app = await buildApp(handle.db);
    app.post("/api/__monitoring_probe", async (request) => {
      const body = request.body as { customerName?: string; idNumber?: string; amount?: string };
      throw new Error(`could not post ${body.customerName} ${body.idNumber} ${body.amount}`);
    });
    app.get("/api/__monitoring_missing", async () => {
      const error = new Error("missing teller") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    });
  });

  afterAll(async () => {
    if (previousDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previousDsn;
    if (previousCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = previousCommit;
    if (previousEnvironment === undefined) delete process.env.SENTRY_ENVIRONMENT;
    else process.env.SENTRY_ENVIRONMENT = previousEnvironment;
    const { close } = await import("@sentry/node");
    await close(2000);
    await app.close();
    await handle.close();
  });

  beforeEach(() => {
    envelopes.length = 0;
    resetRateLimits();
  });

  it("keeps /api/health the same once tracking is on", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "currencydesk-server" });
  });

  it("captures a thrown server error with the name, id, amount, cookie, and authorization removed", async () => {
    const quietProbe = await quietApp.inject({
      method: "POST",
      url: "/api/__monitoring_probe",
      payload: { customerName: CUSTOMER, idNumber: ID_NUMBER, amount: AMOUNT },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/__monitoring_probe",
      headers: { authorization: `Bearer ${TOKEN}`, cookie: COOKIE },
      payload: { customerName: CUSTOMER, idNumber: ID_NUMBER, amount: AMOUNT },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(quietProbe.json());
    await flush(2000);
    expect(envelopes.length).toBeGreaterThan(0);
    const sent = envelopes.join("\n");
    expect(sent).toContain(COMMIT);
    expect(sent).toContain("\"environment\":\"ci\"");
    expect(sent).not.toContain(CUSTOMER);
    expect(sent).not.toContain(ID_NUMBER);
    expect(sent).not.toContain(AMOUNT);
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toContain(COOKIE);
    expect(sent).not.toContain("Bearer");
    expect(sent).toContain("could not post");
  });

  it("does not capture a 4xx", async () => {
    const res = await app.inject({ method: "GET", url: "/api/__monitoring_missing" });
    expect(res.statusCode).toBe(404);
    await flush(2000);
    expect(envelopes.join("\n")).not.toContain("missing teller");
  });

  it("forwards a browser report and does not also log it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/client-errors",
        payload: { message: "rate board failed", route: "/app", version: "0.1.0" },
      });
      expect(res.statusCode).toBe(204);
      await flush(2000);
      const sent = envelopes.join("\n");
      expect(sent).toContain("rate board failed");
      expect(sent).toContain(COMMIT);
      const logged = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("client-error"));
      expect(logged).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  it("does not put the DSN on the deep health body", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health/deep" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(FAKE_DSN);
    expect(res.body).not.toContain("sentry.invalid");
    expect(res.json().commit).toBe(COMMIT);
  });

  it("registers process handlers only outside tests", async () => {
    const sentry = await import("@sentry/node");
    const before = process.listenerCount("uncaughtException");
    const production = sentryIntegrations("production", sentry);
    expect(process.listenerCount("uncaughtException")).toBe(before);
    expect(production.map((item) => item.name).sort()).toEqual(["OnUncaughtException", "OnUnhandledRejection"]);
    expect(sentryIntegrations("test", sentry)).toEqual([]);
    expect(getClient()?.getIntegrationByName("OnUncaughtException")).toBeUndefined();
  });
});
