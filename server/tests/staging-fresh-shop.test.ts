/* Staging-only fresh shop. The route exists only when STAGING is
   exactly "1". A live host is 404, including a spoofed forwarded
   host. A real staging host holds a pending signup, returns the
   6-digit code and a one-time password once, and the existing
   verify step creates the shop. */
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { verifyPassword } from "../src/auth/password.js";
import { forget as forgetCooldown } from "../src/cooldown.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { codeMatches } from "../src/email.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { FRESH_SHOP_IP_MAX, resetFreshShopThrottle } from "../src/routes/staging-fresh-shop.js";

const STAGING_HOST = "staging.currencydeskos.com";
const LIVE_HOSTS = ["www.currencydeskos.com", "currencydesk.onrender.com", "currencydeskos.com"] as const;

const saved = {
  STAGING: process.env.STAGING,
  IS_PULL_REQUEST: process.env.IS_PULL_REQUEST,
  RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  PGLITE_MEMORY: process.env.PGLITE_MEMORY,
  EARLY_ACCESS_OPEN: process.env.EARLY_ACCESS_OPEN,
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

async function boot(
  flag: string | undefined,
  externalHost: string,
): Promise<{ app: FastifyInstance; handle: DbHandle; logs: string[] }> {
  restoreEnv();
  process.env.PGLITE_MEMORY = "1";
  delete process.env.IS_PULL_REQUEST;
  if (flag === undefined) delete process.env.STAGING;
  else process.env.STAGING = flag;
  process.env.RENDER_EXTERNAL_HOSTNAME = externalHost;
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const handle = await createDb();
  await seed(handle.db);
  const app = await buildApp(handle.db, {}, logStream);
  return { app, handle, logs };
}

const freshHeaders = { host: STAGING_HOST };

async function yorkSnapshot(handle: DbHandle) {
  const tenant = await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-yorkfx"));
  const staff = await handle.db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.tenantId, "tnt-yorkfx"));
  const audits = await handle.db.select({ id: schema.auditEvents.id }).from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, "tnt-yorkfx"));
  return { tenant, staff: staff.map((row) => row.id).sort(), audits: audits.length };
}

describe("fresh-shop live refusal", () => {
  it("does not register the route without STAGING exactly 1", async () => {
    for (const flag of [undefined, "true", "0"]) {
      const { app, handle } = await boot(flag, STAGING_HOST);
      try {
        expect(app.hasRoute({ method: "POST", url: "/api/staging/fresh-shop" }), JSON.stringify(flag)).toBe(false);
        const res = await app.inject({
          method: "POST",
          url: "/api/staging/fresh-shop",
          headers: { host: STAGING_HOST, "x-forwarded-host": STAGING_HOST, forwarded: `host=${STAGING_HOST}` },
        });
        expect(res.statusCode, JSON.stringify(flag)).toBe(404);
      } finally {
        await app.close();
        await handle.close();
      }
    }
  }, 60_000);

  it("registers on the flag and still 404s for live hosts and spoofed forwards", async () => {
    const { app, handle } = await boot("1", STAGING_HOST);
    try {
      expect(app.hasRoute({ method: "POST", url: "/api/staging/fresh-shop" })).toBe(true);
      for (const live of LIVE_HOSTS) {
        const plain = await app.inject({ method: "POST", url: "/api/staging/fresh-shop", headers: { host: live } });
        expect(plain.statusCode, live).toBe(404);
        const forwardedHost = await app.inject({
          method: "POST",
          url: "/api/staging/fresh-shop",
          headers: { host: live, "x-forwarded-host": STAGING_HOST },
        });
        expect(forwardedHost.statusCode, `x-forwarded-host ${live}`).toBe(404);
        const forwarded = await app.inject({
          method: "POST",
          url: "/api/staging/fresh-shop",
          headers: { host: live, forwarded: `for=203.0.113.5;host=${STAGING_HOST}` },
        });
        expect(forwarded.statusCode, `forwarded ${live}`).toBe(404);
      }
      const pending = await handle.db.select({ email: schema.pendingSignups.email }).from(schema.pendingSignups);
      expect(pending).toEqual([]);
    } finally {
      await app.close();
      await handle.close();
    }
  }, 60_000);

  it("stays 404 when the process hostname is live, even if the request names staging", async () => {
    const { app, handle } = await boot("1", "www.currencydeskos.com");
    try {
      expect(app.hasRoute({ method: "POST", url: "/api/staging/fresh-shop" })).toBe(true);
      const res = await app.inject({
        method: "POST",
        url: "/api/staging/fresh-shop",
        headers: { host: STAGING_HOST, "x-forwarded-host": STAGING_HOST, forwarded: `host=${STAGING_HOST}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
      await handle.close();
    }
  }, 60_000);
});

describe("fresh-shop creation", () => {
  it("creates a test shop the owner finishes with the code shown, and the cap holds", async () => {
    const { app, handle, logs } = await boot("1", STAGING_HOST);
    const consoleLines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map((arg) => String(arg)).join(" "));
      });
    }
    try {
      const beforeYork = await yorkSnapshot(handle);
      process.env.EARLY_ACCESS_OPEN = "1";
      const live = await app.inject({
        method: "POST",
        url: "/api/signup",
        headers: freshHeaders,
        payload: { businessName: "Live Desk", ownerName: "Ada", email: "ada@livedesk.example", password: "a-strong-pass", slug: "livedesk" },
      });
      expect(live.statusCode).toBe(201);
      expect(live.json()).toEqual({ ok: true, email: "ada@livedesk.example" });
      expect(live.json()).not.toHaveProperty("code");
      expect(live.json()).not.toHaveProperty("password");

      const refused = await app.inject({
        method: "POST",
        url: "/api/signup",
        headers: freshHeaders,
        payload: { businessName: "Nope", ownerName: "Nope", email: "owner+nope@staging.invalid", password: "a-strong-pass", slug: "nope-shop" },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).not.toHaveProperty("code");
      expect(refused.json()).not.toHaveProperty("password");

      const first = await app.inject({
        method: "POST",
        url: "/api/staging/fresh-shop",
        headers: { ...freshHeaders, "content-type": "application/json" },
        payload: { slug: "yorkfx", tenantId: "tnt-yorkfx", email: "owner@yorkfx.example" },
      });
      expect(first.statusCode).toBe(201);
      const opened = first.json() as { ok: boolean; email: string; slug: string; code: string; password: string };
      expect(Object.keys(opened).sort()).toEqual(["code", "email", "ok", "password", "slug"]);
      expect(opened.ok).toBe(true);
      expect(opened.slug).toMatch(/^stg-[a-f0-9]{8}$/);
      expect(opened.slug).not.toBe("yorkfx");
      expect(opened.email).toBe(`owner+${opened.slug.slice(4)}@staging.invalid`);
      expect(opened.code).toMatch(/^\d{6}$/);
      expect(opened.password).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{5}-[abcdefghjkmnpqrstuvwxyz23456789]{5}-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);

      const pending = (await handle.db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, opened.email)))[0];
      expect(pending).toBeTruthy();
      expect(pending!.slug).toBe(opened.slug);
      expect(pending!.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(pending!.codeHash).not.toBe(opened.code);
      expect(codeMatches(opened.code, pending!.codeHash)).toBe(true);
      expect(pending!.passwordHash.startsWith("scrypt$")).toBe(true);
      expect(pending!.passwordHash).not.toContain(opened.password);
      expect(await verifyPassword(opened.password, pending!.passwordHash)).toBe(true);
      expect(JSON.stringify(pending!.onboarding)).not.toContain(opened.password);
      expect(JSON.stringify(pending!.onboarding)).not.toContain(opened.code);
      expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, `tnt-${opened.slug}`))).length).toBe(0);

      const again = await app.inject({ method: "POST", url: "/api/staging/fresh-shop/code", headers: freshHeaders });
      expect(again.statusCode).toBe(404);
      const readBack = await app.inject({ method: "GET", url: "/api/staging/fresh-shop", headers: freshHeaders });
      expect(readBack.statusCode).toBe(404);

      const resend = await app.inject({
        method: "POST",
        url: "/api/signup/resend",
        headers: freshHeaders,
        payload: { email: opened.email },
      });
      expect(resend.json()).toEqual({ ok: true });
      const still = (await handle.db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, opened.email)))[0];
      expect(still!.codeHash).toBe(pending!.codeHash);

      const wrongCode = opened.code === "000000" ? "000001" : "000000";
      const wrong = await app.inject({
        method: "POST",
        url: "/api/signup/verify",
        headers: freshHeaders,
        payload: { email: opened.email, code: wrongCode },
      });
      expect(wrong.statusCode).toBe(401);
      const verified = await app.inject({
        method: "POST",
        url: "/api/signup/verify",
        headers: freshHeaders,
        payload: { email: opened.email, code: opened.code },
      });
      expect(verified.statusCode).toBe(201);
      expect(JSON.stringify(verified.json())).not.toContain(opened.password);
      expect(JSON.stringify(verified.json())).not.toContain(opened.code);
      const tenantId = `tnt-${opened.slug}`;
      expect(verified.json().user.tenantId).toBe(tenantId);
      expect(verified.json().user.mustChangePassword).toBe(true);

      const tenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0];
      expect(tenant).toMatchObject({ siteSlug: opened.slug, plan: "trial", isTestShop: true });
      const entity = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, tenantId)))[0];
      expect(entity!.jurisdiction).toBe("");
      const owner = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, opened.email)))[0];
      expect(owner).toMatchObject({ role: "administrator", tenantId, mustChangePassword: true });
      expect(owner!.passwordHash).not.toContain(opened.password);
      expect(await verifyPassword(opened.password, owner!.passwordHash)).toBe(true);
      expect((await handle.db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, opened.email))).length).toBe(0);

      const created = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "staging.fresh_shop_created"));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ tenantId });
      expect(JSON.stringify(created[0]!.detail)).not.toContain(opened.password);
      expect(JSON.stringify(created[0]!.detail)).not.toContain(opened.code);

      const passwordOnly = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: freshHeaders,
        payload: { staffId: opened.email, password: opened.password },
      });
      expect(passwordOnly.statusCode).toBe(403);
      expect(passwordOnly.json().error).toBe("code_required");
      expect(passwordOnly.json()).not.toHaveProperty("code");

      const start = await app.inject({
        method: "POST",
        url: "/api/auth/login/start",
        headers: freshHeaders,
        payload: { staffId: opened.email, password: opened.password },
      });
      expect(start.statusCode).toBe(200);
      const started = start.json() as { needsCode: boolean; code: string; user: { mustChangePassword: boolean; tenantId: string } };
      expect(started.needsCode).toBe(true);
      expect(started.code).toMatch(/^\d{6}$/);
      expect(started.user.mustChangePassword).toBe(true);
      expect(start.json()).not.toHaveProperty("password");
      const proof = start.cookies.find((cookie) => cookie.name === "cdos_login_proof")?.value;
      expect(proof).toBeTruthy();
      const signedIn = await app.inject({
        method: "POST",
        url: "/api/auth/login/verify",
        headers: freshHeaders,
        cookies: { cdos_login_proof: proof! },
        payload: { staffId: opened.email, code: started.code },
      });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().user).toMatchObject({ tenantId, mustChangePassword: true });

      const second = await app.inject({
        method: "POST",
        url: "/api/staging/fresh-shop",
        headers: { host: `${STAGING_HOST}:443`, forwarded: "host=www.currencydeskos.com" },
      });
      expect(second.statusCode).toBe(201);
      const other = second.json() as { email: string; slug: string; code: string; password: string };
      expect(other.slug).not.toBe(opened.slug);
      expect(other.password).not.toBe(opened.password);
      const secondOk = await app.inject({
        method: "POST",
        url: "/api/signup/verify",
        headers: freshHeaders,
        payload: { email: other.email, code: other.code },
      });
      expect(secondOk.statusCode).toBe(201);
      const secondTenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, `tnt-${other.slug}`)))[0];
      expect(secondTenant).toMatchObject({ isTestShop: true, plan: "trial", siteSlug: other.slug });
      expect(secondTenant!.id).not.toBe(tenantId);

      const held = await app.inject({ method: "POST", url: "/api/staging/fresh-shop", headers: freshHeaders });
      expect(held.statusCode).toBe(201);
      const parked = held.json() as { email: string; slug: string; code: string; password: string };
      const liveVerify = await app.inject({
        method: "POST",
        url: "/api/signup/verify",
        headers: { host: "www.currencydeskos.com", "x-forwarded-host": STAGING_HOST, forwarded: `host=${STAGING_HOST}` },
        payload: { email: parked.email, code: parked.code, isTestShop: true, is_test_shop: true, testShop: true },
      });
      expect(liveVerify.statusCode).toBe(201);
      const parkedTenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, `tnt-${parked.slug}`)))[0];
      expect(parkedTenant).toMatchObject({ isTestShop: false, plan: "trial" });
      const parkedOwner = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, parked.email)))[0];
      expect(parkedOwner!.mustChangePassword).toBe(false);

      expect(await yorkSnapshot(handle)).toEqual(beforeYork);

      resetFreshShopThrottle();
      const slugs = new Set<string>();
      const secrets = [opened.code, opened.password, other.code, other.password, parked.code, parked.password, started.code];
      for (let i = 0; i < FRESH_SHOP_IP_MAX; i++) {
        const res = await app.inject({ method: "POST", url: "/api/staging/fresh-shop", headers: freshHeaders });
        expect(res.statusCode, `call ${i}`).toBe(201);
        const body = res.json() as { slug: string; code: string; password: string };
        slugs.add(body.slug);
        secrets.push(body.code, body.password);
      }
      expect(slugs.size).toBe(FRESH_SHOP_IP_MAX);
      const pendingBeforeCap = (await handle.db.select({ id: schema.pendingSignups.id }).from(schema.pendingSignups)).length;
      const blocked = await app.inject({ method: "POST", url: "/api/staging/fresh-shop", headers: freshHeaders });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "slow_down" });
      expect(blocked.json()).not.toHaveProperty("code");
      expect(blocked.json()).not.toHaveProperty("password");
      const pendingAfterCap = (await handle.db.select({ id: schema.pendingSignups.id }).from(schema.pendingSignups)).length;
      expect(pendingAfterCap).toBe(pendingBeforeCap);

      const haystack = logs.join("\n") + "\n" + consoleLines.join("\n");
      for (const secret of secrets) {
        const leaked = /^\d{6}$/.test(secret)
          ? new RegExp(`(^|[^0-9])${secret}([^0-9]|$)`).test(haystack)
          : haystack.includes(secret);
        expect(leaked, "secret reached a log").toBe(false);
      }
      expect(haystack).not.toContain("[email simulated] to=owner+");

      forgetCooldown("login:" + owner!.id);
      const liveStart = await app.inject({
        method: "POST",
        url: "/api/auth/login/start",
        headers: { host: "www.currencydeskos.com", "x-forwarded-host": STAGING_HOST, forwarded: `host=${STAGING_HOST}` },
        payload: { staffId: opened.email, password: opened.password },
      });
      expect(liveStart.statusCode).toBe(200);
      expect(liveStart.json().needsCode).toBe(true);
      expect(liveStart.json()).not.toHaveProperty("code");
      const liveCode = [...consoleLines].reverse().join("\n").match(/(\d{6}) is your CurrencyDesk sign-in code/)?.[1];
      expect(liveCode).toMatch(/^\d{6}$/);
      expect(JSON.stringify(liveStart.json())).not.toContain(liveCode!);
    } finally {
      await app.close();
      await handle.close();
    }
  }, 90_000);

  it("a live signup body cannot set is_test_shop", async () => {
    const { app, handle } = await boot("1", STAGING_HOST);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    process.env.EARLY_ACCESS_OPEN = "1";
    try {
      const email = "ada@livedesk-flag.example";
      const signup = await app.inject({
        method: "POST",
        url: "/api/signup",
        headers: { host: "www.currencydeskos.com" },
        payload: {
          businessName: "Live Desk",
          ownerName: "Ada",
          email,
          password: "a-strong-pass",
          slug: "livedesk-flag",
          isTestShop: true,
          is_test_shop: true,
          testShop: true,
          onboarding: { isTestShop: true, is_test_shop: true, testShop: true, plan: "trial" },
        },
      });
      expect(signup.statusCode).toBe(201);
      expect(signup.json()).not.toHaveProperty("code");
      expect(signup.json()).not.toHaveProperty("isTestShop");
      const code = [...lines].reverse().join("\n").match(/(\d{6}) is your/)?.[1];
      expect(code).toMatch(/^\d{6}$/);
      const verified = await app.inject({
        method: "POST",
        url: "/api/signup/verify",
        headers: { host: "currencydeskos.com", "x-forwarded-host": STAGING_HOST, forwarded: `host=${STAGING_HOST}` },
        payload: { email, code, isTestShop: true, is_test_shop: true, testShop: true },
      });
      expect(verified.statusCode).toBe(201);
      expect(verified.json().user.mustChangePassword).toBe(false);
      const tenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-livedesk-flag")))[0];
      expect(tenant!.isTestShop).toBe(false);
      expect(tenant!.plan).toBe("trial");
    } finally {
      await app.close();
      await handle.close();
    }
  }, 60_000);
});
