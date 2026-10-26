/* Public /api/health is process-up only. /api/health/deep needs team:manage, or the staging door. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { buildApp } from "../src/app.js";
import { clearDeepHealthCache } from "../src/routes/admin.js";

const LIVE = "currencydeskos.com";
const STAGING = "staging.currencydeskos.com";
const TENANT = "tnt-healthprobe";
const PASSWORD = "health-admin-pass";
const SHA = "abcdef1234567890dead";
const SHALLOW = { ok: true, service: "currencydesk-server" };

const saved = {
  STAGING: process.env.STAGING,
  RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  RENDER_GIT_COMMIT: process.env.RENDER_GIT_COMMIT,
};

function putEnv(key: "STAGING" | "RENDER_EXTERNAL_HOSTNAME" | "RENDER_GIT_COMMIT", value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function liveEnv() {
  delete process.env.STAGING;
  process.env.RENDER_EXTERNAL_HOSTNAME = LIVE;
  delete process.env.RENDER_GIT_COMMIT;
}

function stagingEnv() {
  process.env.STAGING = "1";
  process.env.RENDER_EXTERNAL_HOSTNAME = STAGING;
  process.env.RENDER_GIT_COMMIT = SHA;
}

let handle: DbHandle;
let app: FastifyInstance;
let admin: Record<string, string>;
let teller: Record<string, string>;
let support: Record<string, string>;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  const passwordHash = await hashPassword(PASSWORD);
  await handle.db.insert(schema.tenants).values({ id: TENANT, name: "Health Probe" });
  await handle.db.insert(schema.legalEntities).values({ id: "le-healthprobe", tenantId: TENANT, name: "Health Probe" });
  await handle.db.insert(schema.branches).values({
    id: "br-healthprobe", tenantId: TENANT, legalEntityId: "le-healthprobe", name: "Main",
  });
  const people = [["health.admin", "administrator"], ["health.teller", "teller"], ["health.support", "administrator"]] as const;
  for (const [staffId, role] of people) {
    await handle.db.insert(schema.staffUsers).values({
      id: `${TENANT}:${staffId}`, tenantId: TENANT, legalEntityId: "le-healthprobe",
      branchId: "br-healthprobe", staffId, name: staffId, role,
      authorizedBranchIds: ["br-healthprobe"], passwordHash,
      mustChangePassword: false, passwordUpdatedAt: new Date(),
    });
  }
  await handle.db.insert(schema.platformUsers).values([
    { email: "health.admin", name: "Health Admin", role: "owner", status: "active", addedBy: "test" },
    { email: "health.support", name: "Health Support", role: "support", status: "active", addedBy: "test" },
  ]);
  app = await buildApp(handle.db);
  admin = await login("health.admin");
  teller = await login("health.teller");
  support = await login("health.support");
});

function restoreEnv() {
  putEnv("STAGING", saved.STAGING);
  putEnv("RENDER_EXTERNAL_HOSTNAME", saved.RENDER_EXTERNAL_HOSTNAME);
  putEnv("RENDER_GIT_COMMIT", saved.RENDER_GIT_COMMIT);
}

afterEach(() => { restoreEnv(); clearDeepHealthCache(); vi.useRealTimers(); });
afterAll(async () => { restoreEnv(); await app.close(); await handle.close(); });

async function login(staffId: string): Promise<Record<string, string>> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { staffId, password: PASSWORD, tenantId: TENANT },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((item) => item.name === "cdos_session");
  if (!cookie) throw new Error("no session");
  return { cdos_session: cookie.value };
}

function probe(url: string, host: string, cookies?: Record<string, string>, forwarded?: string) {
  return app.inject({
    method: "GET", url, cookies,
    headers: forwarded ? { host, "x-forwarded-host": forwarded } : { host },
  });
}

function noDeployFields(body: object) {
  expect(body).not.toHaveProperty("commit");
  expect(body).not.toHaveProperty("lastMigration");
}

describe("GET /api/health", () => {
  it("makes no database call and has no commit or migration fields in live mode", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    let dbCalls = 0;
    const select = vi.spyOn(handle.db, "select").mockImplementation(() => { dbCalls += 1; throw new Error("queried"); });
    const execute = vi.spyOn(handle.db, "execute").mockImplementation(() => {
      dbCalls += 1;
      return Promise.reject(new Error("queried")) as never;
    });
    try {
      const res = await probe("/api/health", LIVE);
      expect(dbCalls).toBe(0);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SHALLOW);
      noDeployFields(res.json());
      expect(res.body).not.toContain("abcdef");
    } finally { select.mockRestore(); execute.mockRestore(); }
  });

  it("stays shallow when the staging door is open", async () => {
    stagingEnv();
    const res = await probe("/api/health", STAGING);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SHALLOW);
    noDeployFields(res.json());
  });
});

describe("GET /api/health/deep", () => {
  it("is refused unauthenticated on live before a database lookup", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    const select = vi.spyOn(handle.db, "select");
    const execute = vi.spyOn(handle.db, "execute");
    try {
      const res = await probe("/api/health/deep", LIVE, undefined, STAGING);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
      noDeployFields(res.json());
      expect(select).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally { select.mockRestore(); execute.mockRestore(); }
  });

  it("stays refused on a live host when STAGING is set", async () => {
    process.env.STAGING = "1";
    process.env.RENDER_GIT_COMMIT = SHA;
    process.env.RENDER_EXTERNAL_HOSTNAME = LIVE;
    const onLive = await probe("/api/health/deep", LIVE, undefined, STAGING);
    expect(onLive.json()).toEqual({ error: "unauthenticated" });
    process.env.RENDER_EXTERNAL_HOSTNAME = STAGING;
    const spoofed = await probe("/api/health/deep", LIVE, undefined, STAGING);
    expect(spoofed.statusCode).toBe(401);
    expect(spoofed.json()).toEqual({ error: "unauthenticated" });
  });

  it("refuses a desk session and a non-owner platform member", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    const desk = await probe("/api/health/deep", LIVE, teller);
    expect(desk.statusCode).toBe(403);
    expect(desk.json()).toEqual({ error: "forbidden" });
    const member = await probe("/api/health/deep", LIVE, support);
    expect(member.statusCode).toBe(403);
    expect(member.json()).toEqual({ error: "permission_denied" });
    noDeployFields(member.json());
  });

  it("allows the owner on live and staging with no session", async () => {
    liveEnv();
    process.env.RENDER_GIT_COMMIT = SHA;
    const owned = await probe("/api/health/deep", LIVE, admin);
    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toMatchObject({ ...SHALLOW, commit: "abcdef1" });
    expect(owned.json()).toHaveProperty("lastMigration");
    clearDeepHealthCache();
    stagingEnv();
    const open = await probe("/api/health/deep", STAGING, undefined, LIVE);
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ ...SHALLOW, commit: "abcdef1" });
    expect(open.json()).toHaveProperty("lastMigration");
  });

  it("returns 503 when the database cannot answer, and caches it", async () => {
    liveEnv();
    const real = handle.db.select.bind(handle.db);
    let healthReads = 0;
    const select = vi.spyOn(handle.db, "select").mockImplementation((shape?: object) => {
      if (shape && Object.keys(shape).length === 1 && "id" in shape) {
        healthReads += 1;
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432 password=supersecret");
      }
      return real(shape as never);
    });
    try {
      const res = await probe("/api/health/deep", LIVE, admin);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ ...SHALLOW, ok: false, error: "database", commit: "unknown", lastMigration: null });
      expect(res.body).not.toMatch(/ECONNREFUSED|supersecret|password=|5432/i);
      const again = await probe("/api/health/deep", LIVE, admin);
      expect(again.statusCode).toBe(503);
      expect(again.json()).toEqual(res.json());
      expect(healthReads).toBe(1);
    } finally { select.mockRestore(); }
  });

  it("ten deep calls in 30 seconds make one database read", async () => {
    stagingEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T00:00:00.000Z"));
    let reads = 0;
    const real = handle.db.select.bind(handle.db);
    const select = vi.spyOn(handle.db, "select").mockImplementation((shape?: object) => {
      if (shape && Object.keys(shape).length === 1 && "id" in shape) reads += 1;
      return real(shape as never);
    });
    const execute = vi.spyOn(handle.db, "execute");
    try {
      for (let n = 0; n < 10; n += 1) {
        const res = await probe("/api/health/deep", STAGING);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toHaveProperty("commit");
        expect(res.json()).toHaveProperty("lastMigration");
      }
      expect(reads).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-10-26T00:00:30.000Z"));
      await probe("/api/health/deep", STAGING);
      expect(reads).toBe(2);
    } finally { select.mockRestore(); execute.mockRestore(); vi.useRealTimers(); }
  });
});
