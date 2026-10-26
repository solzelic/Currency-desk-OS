/* The staging button opens the real desk setup. It mints an invited
   application and does not email. Launch marks the tenant a test shop
   only when the staging door is open. A live host stays 404. */
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { resetFreshShopThrottle } from "../src/routes/staging-fresh-shop.js";

const STAGING_HOST = "staging.currencydeskos.com";
const saved = {
  STAGING: process.env.STAGING,
  IS_PULL_REQUEST: process.env.IS_PULL_REQUEST,
  RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  PGLITE_MEMORY: process.env.PGLITE_MEMORY,
};

function restoreEnv() {
  for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  resetFreshShopThrottle();
  vi.restoreAllMocks();
});

async function boot(flag: string | undefined, externalHost: string) {
  restoreEnv();
  process.env.PGLITE_MEMORY = "1";
  delete process.env.IS_PULL_REQUEST;
  if (flag === undefined) delete process.env.STAGING;
  else process.env.STAGING = flag;
  process.env.RENDER_EXTERNAL_HOSTNAME = externalHost;
  const handle = await createDb();
  await seed(handle.db);
  const app = await buildApp(handle.db, {}, new Writable({ write(_c, _e, cb) { cb(); } }));
  return { app, handle };
}

describe("fresh onboarding", () => {
  it("is absent on live and opens the real desk setup on staging", async () => {
    const closed = await boot(undefined, STAGING_HOST);
    try {
      expect(closed.app.hasRoute({ method: "POST", url: "/api/staging/fresh-onboarding" })).toBe(false);
    } finally {
      await closed.app.close();
      await closed.handle.close();
    }

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const { app, handle } = await boot("1", STAGING_HOST);
    try {
      const live = await app.inject({ method: "POST", url: "/api/staging/fresh-onboarding", headers: { host: "www.currencydeskos.com" } });
      expect(live.statusCode).toBe(404);

      const opened = await app.inject({ method: "POST", url: "/api/staging/fresh-onboarding", headers: { host: STAGING_HOST } });
      expect(opened.statusCode).toBe(201);
      const body = opened.json() as { ok: boolean; reference: string; email: string; password?: string; code?: string };
      expect(body.ok).toBe(true);
      expect(body.reference).toMatch(/^CD-[2-9A-HJ-NP-Z]{6}$/);
      expect(body.email).toMatch(/^owner\+[0-9a-f]+@staging\.invalid$/);
      expect(body.password).toBeUndefined();
      expect(body.code).toBeUndefined();
      expect(lines.join("\n")).not.toContain("[email");
      expect(lines.join("\n")).not.toContain(body.email);

      const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, body.reference)))[0];
      expect(row?.status).toBe("invited");
      expect(row?.kind).toBe("early_access");
      expect(row?.isDemo).toBe(false);
      expect(row?.charterNo).toBeNull();
      expect((row?.details as { stagingFresh?: boolean; slug?: string }).stagingFresh).toBe(true);
      expect(String((row?.details as { slug?: string }).slug)).toMatch(/^stg-/);

      const state = await app.inject({ method: "GET", url: "/api/onboarding/" + body.reference + "/state", headers: { host: STAGING_HOST } });
      expect(state.statusCode).toBe(200);
      expect(state.json().data.ownerEmail).toBe(body.email);

      await app.inject({
        method: "PUT", url: "/api/onboarding/" + body.reference + "/state", headers: { host: STAGING_HOST },
        payload: { at: 5, data: { country: "CA", operatingName: "Harbour Test", bizName: "Harbour Test Inc.", ownerName: "Staging owner", ownerEmail: body.email, plan: "full" } },
      });
      const sent = await app.inject({
        method: "POST", url: "/api/onboarding/" + body.reference + "/verify/send", headers: { host: STAGING_HOST },
        payload: { data: { ownerEmail: body.email, operatingName: "Harbour Test" } },
      });
      expect(sent.statusCode).toBe(200);
      const code = (sent.json() as { code?: string }).code;
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(lines.join("\n")).not.toContain(String(code));
      expect(sent.json().channel).toBe("email");

      const checked = await app.inject({
        method: "POST", url: "/api/onboarding/" + body.reference + "/verify/check", headers: { host: STAGING_HOST },
        payload: { code },
      });
      expect(checked.statusCode).toBe(200);

      const launch = await app.inject({
        method: "POST", url: "/api/onboarding/" + body.reference + "/launch", headers: { host: STAGING_HOST },
        payload: { data: { ownerPass: "north-yard-9", ownerEmail: body.email, operatingName: "Harbour Test", bizName: "Harbour Test Inc.", country: "CA", ownerName: "Staging owner", plan: "full" } },
      });
      expect(launch.statusCode).toBe(201);
      const tenantId = (launch.json() as { tenantId: string }).tenantId;
      const tenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0];
      expect(tenant?.isTestShop).toBe(true);
      expect(tenant?.siteSlug?.startsWith("stg-")).toBe(true);
      const owner = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, body.email)))[0];
      expect(owner?.mustChangePassword).toBe(false);
    } finally {
      await app.close();
      await handle.close();
    }
  });
});
