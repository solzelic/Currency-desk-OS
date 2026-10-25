/* Staging quick sign-in. 404 unless STAGING is exactly "1", both hosts are staging, and the shop is tnt-yorkfx. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { STAGING_SESSION_TTL_MS } from "../src/routes/staging-signin.js";

const HOST = "staging.currencydeskos.com";
const PREVIEW = "currencydesk-staging-pr-5.onrender.com";
const DAY = 24 * 60 * 60 * 1000;
const PEOPLE = {
  administrator: "j.masri",
  branch_manager: "r.haddad",
  supervisor: "a.singh",
  compliance_officer: "c.adebayo",
  teller: "m.costa",
  auditor: "l.berg",
} as const;

const saved = {
  STAGING: process.env.STAGING,
  IS_PULL_REQUEST: process.env.IS_PULL_REQUEST,
  RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  PGLITE_MEMORY: process.env.PGLITE_MEMORY,
  SEED_PASSWORD: process.env.SEED_PASSWORD,
};

function restoreEnv() {
  for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function stageEnv(on: boolean) {
  restoreEnv();
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  delete process.env.IS_PULL_REQUEST;
  if (on) {
    process.env.STAGING = "1";
    process.env.RENDER_EXTERNAL_HOSTNAME = HOST;
  } else {
    delete process.env.STAGING;
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
  }
}

async function boot(on: boolean): Promise<{ app: FastifyInstance; handle: DbHandle }> {
  stageEnv(on);
  const handle = await createDb();
  await seed(handle.db);
  const app = await buildApp(handle.db);
  return { app, handle };
}

function configOn(res: { statusCode: number; json: () => { enabled?: boolean } }): boolean {
  return res.statusCode === 200 && res.json().enabled === true;
}

describe("quick sign-in refused without the flag", () => {
  afterAll(restoreEnv);

  it("does not mount the door unless STAGING is exactly 1", async () => {
    for (const flag of [undefined, "true", " 1", "0", "1 "] as const) {
      if (flag === undefined) delete process.env.STAGING;
      else process.env.STAGING = flag;
      process.env.PGLITE_MEMORY = "1";
      process.env.SEED_PASSWORD = "yorkville";
      process.env.RENDER_EXTERNAL_HOSTNAME = HOST;
      const handle = await createDb();
      await seed(handle.db);
      const app = await buildApp(handle.db);
      try {
        expect(app.hasRoute({ method: "GET", url: "/api/staging/signin" }), JSON.stringify(flag)).toBe(false);
        expect(app.hasRoute({ method: "POST", url: "/api/staging/enter" }), JSON.stringify(flag)).toBe(false);
        const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: HOST } });
        expect(cfg.statusCode, JSON.stringify(flag)).toBe(404);
        expect(configOn(cfg), JSON.stringify(flag)).toBe(false);
      } finally {
        await app.close();
        await handle.close();
      }
    }
  }, 30_000);
});

describe("quick sign-in on the demo shop", () => {
  let app: FastifyInstance;
  let handle: DbHandle;
  beforeAll(async () => {
    const booted = await boot(true);
    app = booted.app;
    handle = booted.handle;
    app.addHook("onRequest", async (req) => {
      if (req.headers["x-strip-host"] === "1") delete req.headers.host;
    });
  });
  afterAll(async () => {
    restoreEnv();
    await app.close();
    await handle.close();
  });

  async function enter(role: string, host = HOST, extra: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url: "/api/staging/enter", headers: { host }, payload: { role, ...extra } });
  }

  it("refuses a live host, a missing flag, and a shop that is not tnt-yorkfx", async () => {
    process.env.RENDER_EXTERNAL_HOSTNAME = "currencydeskos.com";
    expect((await enter("teller", HOST)).statusCode).toBe(404);
    process.env.RENDER_EXTERNAL_HOSTNAME = HOST;
    for (const host of ["currencydeskos.com", "www.currencydeskos.com", "currencydesk.onrender.com"]) {
      const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host } });
      expect(cfg.statusCode, host).toBe(404);
      expect((await enter("teller", host)).statusCode, host).toBe(404);
      expect(configOn(cfg), host).toBe(false);
    }
    const spoofed = await app.inject({ method: "POST", url: "/api/staging/enter", headers: { host: "currencydeskos.com", "x-forwarded-host": HOST }, payload: { role: "administrator" } });
    expect(spoofed.statusCode).toBe(404);

    for (const host of ["evil.example.com", "currencydesk-pr-5.onrender.com"]) {
      expect((await enter("teller", host)).statusCode, host).toBe(404);
    }
    const bare = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: HOST, "x-strip-host": "1" } });
    expect(bare.statusCode).toBe(404);
    expect(configOn(bare)).toBe(false);

    await handle.db.update(schema.tenants).set({ siteSlug: "real-shop" }).where(eq(schema.tenants.id, DEMO.tenantId));
    try {
      const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: HOST } });
      const res = await enter("administrator", HOST, { tenantId: "tnt-other" });
      expect(cfg.statusCode).toBe(404);
      expect(res.statusCode).toBe(404);
      expect(res.cookies.find((c) => c.name === "cdos_session")).toBeUndefined();
    } finally {
      await handle.db.update(schema.tenants).set({ siteSlug: "yorkfx" }).where(eq(schema.tenants.id, DEMO.tenantId));
    }
  });

  it("opens a 3-day demo session and records the entry", async () => {
    const cfg = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: HOST } });
    expect(configOn(cfg)).toBe(true);

    for (const [role, id] of Object.entries(PEOPLE)) {
      const res = await enter(role);
      expect(res.statusCode, role).toBe(200);
      expect(res.json().user, role).toMatchObject({ id, role, tenantId: DEMO.tenantId });
      expect(res.json().staging).toBe(true);
    }
    expect((await enter("owner")).statusCode).toBe(400);
    expect((await enter("teller", HOST, { tenantId: "tnt-other" })).statusCode).toBe(400);
    const form = await app.inject({ method: "POST", url: "/api/staging/enter", headers: { host: HOST, "content-type": "application/x-www-form-urlencoded" }, payload: "role=teller" });
    expect(form.statusCode).toBe(415);

    const teller = await enter("teller");
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

    const publish = await app.inject({ method: "POST", url: "/api/rates/publish", cookies: { cdos_session: session!.value }, payload: {} });
    expect(publish.statusCode).toBe(403);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { host: HOST }, cookies: { cdos_session: session!.value, cdos_staging: "1" } });
    expect(me.json().staging).toBe(true);
    expect(me.json().user.role).toBe("teller");
    const bareMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { host: HOST, "x-strip-host": "1" }, cookies: { cdos_session: session!.value, cdos_staging: "1" } });
    expect(bareMe.json().staging).toBe(false);

    process.env.IS_PULL_REQUEST = "true";
    process.env.RENDER_EXTERNAL_HOSTNAME = PREVIEW;
    const preview = await enter("auditor", PREVIEW);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().user).toMatchObject({ id: "l.berg", role: "auditor", tenantId: DEMO.tenantId });
    delete process.env.IS_PULL_REQUEST;
    expect((await enter("auditor", PREVIEW)).statusCode).toBe(404);
    process.env.RENDER_EXTERNAL_HOSTNAME = HOST;

    const agent = `${"DeskBrowser/1 ".repeat(40)}tail`;
    const traced = await app.inject({ method: "POST", url: "/api/staging/enter", headers: { host: HOST, "user-agent": agent, "x-forwarded-for": "198.51.100.9, 203.0.113.21" }, payload: { role: "supervisor" }, remoteAddress: "10.21.0.8" });
    expect(traced.statusCode).toBe(200);
    const events = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "auth.staging_enter"));
    expect(events.length).toBeGreaterThanOrEqual(Object.keys(PEOPLE).length);
    const tracedDetail = events.map((event) => event.detail).find((detail) => detail.role === "supervisor" && detail.ip === "203.0.113.21");
    expect(tracedDetail).toMatchObject({ role: "supervisor", host: HOST, ip: "203.0.113.21", at: expect.any(String), userAgent: agent.slice(0, 500) });
    for (const event of events) {
      expect(event.detail).toMatchObject({ host: expect.any(String), role: expect.any(String), at: expect.any(String), ip: expect.any(String), userAgent: expect.any(String) });
      expect(event.at).toBeInstanceOf(Date);
      expect(JSON.stringify(event.detail)).not.toMatch(/password|token|cookie|secret|yorkville/i);
    }

    const normal = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: HOST }, payload: { staffId: "j.masri", password: "yorkville", tenantId: DEMO.tenantId } });
    expect(normal.statusCode).toBe(200);
    const normalLife = new Date(normal.cookies.find((c) => c.name === "cdos_session")!.expires!).getTime() - Date.now();
    expect(normalLife).toBeGreaterThan(11 * 60 * 60 * 1000);
    expect(normalLife).toBeLessThan(13 * 60 * 60 * 1000);
    expect(normal.cookies.find((c) => c.name === "cdos_staging" && c.value === "1")).toBeUndefined();

    const limitedIp = "203.0.113.50";
    let last = 0;
    for (let n = 0; n < 21; n++) {
      last = (await app.inject({ method: "POST", url: "/api/staging/enter", headers: { host: HOST }, payload: { role: "teller" }, remoteAddress: limitedIp })).statusCode;
      if (n < 20) expect(last, String(n + 1)).toBe(200);
    }
    expect(last).toBe(429);
  });
});
