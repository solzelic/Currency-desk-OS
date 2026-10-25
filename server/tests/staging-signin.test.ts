/* Staging quick sign-in. Written against the missing route first.
   The door is 404 unless STAGING=1, the Host header is the staging
   site or this service's pull-request preview, and the shop is York FX.
   A live host stays 404 even with the flag set. */
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hasBackendPermission } from "../src/auth/permissions.js";
import { isStagingRuntime, requestHost } from "../src/auth/staging-runtime.js";
import { STAGING_SESSION_TTL_MS } from "../src/routes/staging-signin.js";

const { canSeeStr, presentDeal } = createRequire(import.meta.url)("../../shared/str-role.js") as {
  canSeeStr: (role: string) => boolean;
  presentDeal: (role: string, deal: Record<string, unknown>) => Record<string, unknown>;
};

const HOST = "staging.currencydeskos.com";
const PREVIEW = "currencydesk-pr-42.onrender.com";
const DAY = 24 * 60 * 60 * 1000;

function configOn(res: { statusCode: number; json: () => { enabled?: boolean } }): boolean {
  if (res.statusCode !== 200) return false;
  return res.json().enabled === true;
}

async function boot(flag: boolean): Promise<{ app: FastifyInstance; handle: DbHandle }> {
  if (flag) process.env.STAGING = "1";
  else delete process.env.STAGING;
  delete process.env.IS_PULL_REQUEST;
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  const handle = await createDb();
  await seed(handle.db);
  const app = await buildApp(handle.db);
  return { app, handle };
}

describe("isStagingRuntime", () => {
  const env = { STAGING: "1" } as NodeJS.ProcessEnv;

  it("reads the Host header the app already trusts, and ignores a forwarded host", () => {
    expect(requestHost("Staging.CurrencyDeskOS.com:443")).toBe(HOST);
    expect(requestHost(["staging.currencydeskos.com", "currencydeskos.com"])).toBe(HOST);
    expect(requestHost(undefined)).toBe("");
  });

  it("allows the staging host and a preview only with the flag and IS_PULL_REQUEST", () => {
    expect(isStagingRuntime(HOST, env)).toBe(true);
    expect(isStagingRuntime(HOST, {})).toBe(false);
    expect(isStagingRuntime("currencydeskos.com", env)).toBe(false);
    expect(isStagingRuntime("www.currencydeskos.com", env)).toBe(false);
    expect(isStagingRuntime(PREVIEW, env)).toBe(false);
    expect(isStagingRuntime(PREVIEW, { ...env, IS_PULL_REQUEST: "true" })).toBe(true);
    expect(isStagingRuntime("currencydesk.onrender.com", { ...env, IS_PULL_REQUEST: "true" })).toBe(false);
    expect(isStagingRuntime("currencydesk-pr-42.onrender.com.evil.com", { ...env, IS_PULL_REQUEST: "true" })).toBe(false);
  });
});

describe("quick sign-in refused without the flag", () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  beforeAll(async () => {
    const booted = await boot(false);
    app = booted.app;
    handle = booted.handle;
  });
  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it("does not mount the door, so the config stays off", async () => {
    const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: HOST } });
    const enter = await app.inject({ method: "POST", url: "/api/staging/enter", headers: { host: HOST }, payload: { role: "teller" } });
    expect(cfg.statusCode).toBe(404);
    expect(enter.statusCode).toBe(404);
    expect(configOn(cfg)).toBe(false);
    expect(enter.cookies.find((c) => c.name === "cdos_session")).toBeUndefined();
  });
});

describe("quick sign-in on the demo shop", () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  beforeAll(async () => {
    const booted = await boot(true);
    app = booted.app;
    handle = booted.handle;
  });
  afterAll(async () => {
    delete process.env.STAGING;
    delete process.env.IS_PULL_REQUEST;
    await app.close();
    await handle.close();
  });

  async function enter(role: string, host = HOST, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/staging/enter",
      headers: { host },
      payload: { role, ...extra },
    });
  }

  it("refuses live hosts, a spoofed forwarded host, an unknown role, and a non-demo shop", async () => {
    for (const host of ["currencydeskos.com", "www.currencydeskos.com", "currencydesk.onrender.com"]) {
      const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host } });
      const res = await enter("teller", host);
      expect(cfg.statusCode, host).toBe(404);
      expect(res.statusCode, host).toBe(404);
      expect(configOn(cfg), host).toBe(false);
    }
    const spoofed = await app.inject({
      method: "POST",
      url: "/api/staging/enter",
      headers: { host: "currencydeskos.com", "x-forwarded-host": HOST },
      payload: { role: "administrator" },
    });
    expect(spoofed.statusCode).toBe(404);
    expect(configOn(await app.inject({
      method: "GET",
      url: "/api/staging/signin",
      headers: { host: "www.currencydeskos.com", "x-forwarded-host": HOST },
    }))).toBe(false);

    const unknown = await enter("owner");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.cookies.find((c) => c.name === "cdos_session")).toBeUndefined();

    await handle.db.update(schema.tenants).set({ siteSlug: "real-shop" }).where(eq(schema.tenants.id, DEMO.tenantId));
    try {
      const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: HOST } });
      const res = await enter("administrator");
      expect(cfg.statusCode).toBe(404);
      expect(res.statusCode).toBe(404);
      expect(configOn(cfg)).toBe(false);
      expect(res.cookies.find((c) => c.name === "cdos_session")).toBeUndefined();
    } finally {
      await handle.db.update(schema.tenants).set({ siteSlug: "yorkfx" }).where(eq(schema.tenants.id, DEMO.tenantId));
    }
  });

  it("opens a 3-day demo session on staging and on a preview, with that role's STR access", async () => {
    const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: HOST } });
    expect(configOn(cfg)).toBe(true);

    const teller = await enter("teller", HOST, { tenantId: "tnt-other" });
    expect(teller.statusCode).toBe(200);
    expect(teller.json().user).toMatchObject({ id: "m.costa", role: "teller", tenantId: DEMO.tenantId });
    expect(teller.json().staging).toBe(true);
    const session = teller.cookies.find((c) => c.name === "cdos_session");
    const marker = teller.cookies.find((c) => c.name === "cdos_staging");
    expect(session?.httpOnly).toBe(true);
    expect(marker?.value).toBe("1");
    const life = new Date(session!.expires!).getTime() - Date.now();
    expect(life).toBeGreaterThan(STAGING_SESSION_TTL_MS - 60_000);
    expect(life).toBeLessThan(STAGING_SESSION_TTL_MS + 60_000);

    const row = await handle.db.select().from(schema.sessions).where(eq(schema.sessions.userId, `${DEMO.tenantId}:m.costa`));
    const left = row[0]!.expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(2 * DAY);
    expect(left).toBeLessThan(4 * DAY);

    expect(canSeeStr("teller")).toBe(false);
    expect(hasBackendPermission("teller", "filing:view")).toBe(false);
    const hidden = presentDeal("teller", { strTag: "tagged", strLink: "/str/1", amount: "10.00" });
    expect(hidden.strTag).toBeUndefined();
    expect(hidden.strLink).toBeUndefined();
    expect(hidden.amount).toBe("10.00");
    const publish = await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      cookies: { cdos_session: session!.value },
      payload: {},
    });
    expect(publish.statusCode).toBe(403);

    const officer = await enter("compliance_officer");
    expect(officer.json().user).toMatchObject({ id: "c.adebayo", role: "compliance_officer", tenantId: DEMO.tenantId });
    expect(canSeeStr(officer.json().user.role)).toBe(true);
    expect(hasBackendPermission("compliance_officer", "filing:view")).toBe(true);
    expect(presentDeal("compliance_officer", { strTag: "tagged" }).strTag).toBe("tagged");

    const owner = await enter("administrator");
    const ownerCookie = owner.cookies.find((c) => c.name === "cdos_session")!;
    const ownerPublish = await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      cookies: { cdos_session: ownerCookie.value },
      payload: {},
    });
    expect(ownerPublish.statusCode).not.toBe(403);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { host: HOST },
      cookies: { cdos_session: session!.value, cdos_staging: "1" },
    });
    expect(me.json().staging).toBe(true);
    expect(me.json().user.role).toBe("teller");

    process.env.IS_PULL_REQUEST = "true";
    const preview = await enter("auditor", PREVIEW);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().user).toMatchObject({ id: "l.berg", role: "auditor" });
    expect(canSeeStr("auditor")).toBe(false);
    delete process.env.IS_PULL_REQUEST;
    expect((await enter("auditor", PREVIEW)).statusCode).toBe(404);

    const events = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "auth.staging_enter"));
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) {
      expect(event.detail).toMatchObject({ host: expect.any(String) });
      expect(typeof event.detail.role).toBe("string");
      expect(typeof event.detail.at).toBe("string");
      expect(event.at).toBeInstanceOf(Date);
      const text = JSON.stringify(event.detail);
      expect(text).not.toMatch(/password|token|cookie|secret|yorkville/i);
    }

    const normal = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: HOST },
      payload: { staffId: "j.masri", password: "yorkville", tenantId: DEMO.tenantId },
    });
    expect(normal.statusCode).toBe(200);
    const normalLife = new Date(normal.cookies.find((c) => c.name === "cdos_session")!.expires!).getTime() - Date.now();
    expect(normalLife).toBeGreaterThan(11 * 60 * 60 * 1000);
    expect(normalLife).toBeLessThan(13 * 60 * 60 * 1000);
    expect(normal.cookies.find((c) => c.name === "cdos_staging" && c.value === "1")).toBeUndefined();
  });
});
