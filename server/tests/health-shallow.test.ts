/* Public /api/health is the Render probe. It answers while the process
   is up and does not touch the database. Commit and the last migration
   live on /api/health/deep, for a platform admin, or on staging when
   the shared staging door is open. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { buildApp } from "../src/app.js";

const LIVE_HOST = "currencydeskos.com";
const STAGING_HOST = "staging.currencydeskos.com";
const TENANT = "tnt-healthprobe";
const PASSWORD = "health-admin-pass";
const SHA = "abcdef1234567890dead";

const saved = {
  STAGING: process.env.STAGING,
  RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  RENDER_GIT_COMMIT: process.env.RENDER_GIT_COMMIT,
};

function putEnv(key: "STAGING" | "RENDER_EXTERNAL_HOSTNAME" | "RENDER_GIT_COMMIT", value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv() {
  putEnv("STAGING", saved.STAGING);
  putEnv("RENDER_EXTERNAL_HOSTNAME", saved.RENDER_EXTERNAL_HOSTNAME);
  putEnv("RENDER_GIT_COMMIT", saved.RENDER_GIT_COMMIT);
}

function liveEnv() {
  delete process.env.STAGING;
  process.env.RENDER_EXTERNAL_HOSTNAME = LIVE_HOST;
  delete process.env.RENDER_GIT_COMMIT;
}

let handle: DbHandle;
let app: FastifyInstance;
let admin: Record<string, string>;
let teller: Record<string, string>;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  const passwordHash = await hashPassword(PASSWORD);
  await handle.db.insert(schema.tenants).values({ id: TENANT, name: "Health Probe" });
  await handle.db.insert(schema.legalEntities).values({ id: "le-healthprobe", tenantId: TENANT, name: "Health Probe" });
  await handle.db.insert(schema.branches).values({
    id: "br-healthprobe", tenantId: TENANT, legalEntityId: "le-healthprobe", name: "Main",
  });
  for (const staffId of ["health.admin", "health.teller"] as const) {
    await handle.db.insert(schema.staffUsers).values({
      id: `${TENANT}:${staffId}`,
      tenantId: TENANT,
      legalEntityId: "le-healthprobe",
      branchId: "br-healthprobe",
      staffId,
      name: staffId,
      role: staffId === "health.admin" ? "administrator" : "teller",
      authorizedBranchIds: ["br-healthprobe"],
      passwordHash,
      mustChangePassword: false,
      passwordUpdatedAt: new Date(),
    });
  }
  await handle.db.insert(schema.platformUsers).values({
    email: "health.admin", name: "Health Admin", role: "owner", status: "active", addedBy: "test",
  });
  app = await buildApp(handle.db);
  admin = await login("health.admin");
  teller = await login("health.teller");
});

afterEach(() => { restoreEnv(); });

afterAll(async () => {
  restoreEnv();
  await app.close();
  await handle.close();
});

async function login(staffId: string): Promise<Record<string, string>> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: PASSWORD, tenantId: TENANT },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((item) => item.name === "cdos_session");
  if (!cookie) throw new Error("no session");
  return { cdos_session: cookie.value };
}

function publicHealth() {
  return app.inject({ method: "GET", url: "/api/health", headers: { host: LIVE_HOST } });
}

describe("GET /api/health", () => {
  it("makes no database call", async () => {
    liveEnv();
    let dbCalls = 0;
    const select = vi.spyOn(handle.db, "select").mockImplementation(() => {
      dbCalls += 1;
      throw new Error("public health queried the database");
    });
    const execute = vi.spyOn(handle.db, "execute").mockImplementation(() => {
      dbCalls += 1;
      return Promise.reject(new Error("public health queried the database")) as never;
    });
    try {
      const res = await publicHealth();
      expect(dbCalls).toBe(0);
      expect(select).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, service: "currencydesk-server" });
    } finally {
      select.mockRestore();
      execute.mockRestore();
    }
  });

  it("has no commit or lastMigration in live mode", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    const res = await publicHealth();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "currencydesk-server" });
    expect(res.body).not.toMatch(/commit|lastMigration|abcdef/);
  });

  it("stays shallow when the staging door is open", async () => {
    process.env.STAGING = "1";
    process.env.RENDER_EXTERNAL_HOSTNAME = STAGING_HOST;
    process.env.RENDER_GIT_COMMIT = SHA;
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: STAGING_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "currencydesk-server" });
  });
});

describe("GET /api/health/deep", () => {
  it("is refused unauthenticated on live", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    const res = await app.inject({
      method: "GET",
      url: "/api/health/deep",
      headers: { host: LIVE_HOST, "x-forwarded-host": STAGING_HOST },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
    expect(res.body).not.toMatch(/commit|lastMigration|abcdef/);
  });

  it("stays refused on a live host when STAGING is set", async () => {
    process.env.STAGING = "1";
    process.env.RENDER_GIT_COMMIT = SHA;
    const headers = { host: LIVE_HOST, "x-forwarded-host": STAGING_HOST };
    process.env.RENDER_EXTERNAL_HOSTNAME = LIVE_HOST;
    const onLive = await app.inject({ method: "GET", url: "/api/health/deep", headers });
    expect(onLive.statusCode).toBe(401);
    expect(onLive.body).not.toMatch(/commit|lastMigration|abcdef/);
    process.env.RENDER_EXTERNAL_HOSTNAME = STAGING_HOST;
    const spoofed = await app.inject({ method: "GET", url: "/api/health/deep", headers });
    expect(spoofed.statusCode).toBe(401);
    expect(spoofed.body).not.toMatch(/commit|lastMigration|abcdef/);
  });

  it("refuses a desk session that is not a platform admin", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    const res = await app.inject({
      method: "GET",
      url: "/api/health/deep",
      cookies: teller,
      headers: { host: LIVE_HOST },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toMatch(/commit|lastMigration|abcdef/);
  });

  it("allows a platform admin on live", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    const res = await app.inject({
      method: "GET",
      url: "/api/health/deep",
      cookies: admin,
      headers: { host: LIVE_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      service: "currencydesk-server",
      commit: "abcdef1",
    });
    expect(res.json()).toHaveProperty("lastMigration");
  });

  it("allows staging without a session when the door is open", async () => {
    process.env.STAGING = "1";
    process.env.RENDER_EXTERNAL_HOSTNAME = STAGING_HOST;
    process.env.RENDER_GIT_COMMIT = SHA;
    const res = await app.inject({
      method: "GET",
      url: "/api/health/deep",
      headers: { host: STAGING_HOST, "x-forwarded-host": LIVE_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      service: "currencydesk-server",
      commit: "abcdef1",
    });
    expect(res.json()).toHaveProperty("lastMigration");
  });

  it("returns 503 when the database cannot answer", async () => {
    liveEnv();
    const real = handle.db.select.bind(handle.db);
    const select = vi.spyOn(handle.db, "select").mockImplementation((shape?: object) => {
      if (shape && Object.keys(shape).length === 1 && "id" in shape) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432 password=supersecret");
      }
      return real(shape as never);
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/health/deep",
        cookies: admin,
        headers: { host: LIVE_HOST },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        ok: false,
        service: "currencydesk-server",
        error: "database",
        commit: "unknown",
        lastMigration: null,
      });
      expect(res.body).not.toMatch(/ECONNREFUSED|supersecret|password=|5432/i);
    } finally {
      select.mockRestore();
    }
  });
});
