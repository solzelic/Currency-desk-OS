/* The staging demo: 0000 works as anyone's PIN, beside the one they chose
   (Sol, 3 Nov 2026). Only the server decides, and only when the flag, the
   staging runtime, the request Host and the signed-in session's own shop
   (the staging demo shop or a test shop) all agree. Live and real shops
   never get it, and 0000 is never stored. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { createSession } from "../src/auth/sessions.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { provisionDesk } from "../src/onboarding/provision.js";
import { clearPinAttempts, isWeakPin, lockState } from "../src/routes/pin.js";
import { stagingDefaultPinAllowed } from "../src/auth/staging-default-pin.js";

const STAGING_HOST = "currencydesk-staging.onrender.com";
const STAGING_ENV = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: STAGING_HOST, STAGING_DEFAULT_PIN: "1" };
const TEST_SHOP = { id: "tnt-stg-a1b2", isTestShop: true };
const DEMO_SHOP = { id: "tnt-yorkfx", isTestShop: false };
const here = dirname(fileURLToPath(import.meta.url));

describe("the gate", () => {
  it("opens only with the flag, a staging runtime, a staging Host and the demo or a test shop", () => {
    expect(stagingDefaultPinAllowed(STAGING_HOST, STAGING_ENV, TEST_SHOP)).toBe(true);
    expect(stagingDefaultPinAllowed(STAGING_HOST, STAGING_ENV, DEMO_SHOP)).toBe(true);
    expect(stagingDefaultPinAllowed("www.currencydeskos.com", STAGING_ENV, DEMO_SHOP)).toBe(false);
    expect(stagingDefaultPinAllowed("staging.currencydeskos.com", { ...STAGING_ENV, RENDER_EXTERNAL_HOSTNAME: "staging.currencydeskos.com" }, TEST_SHOP)).toBe(true);
  });

  it.each([
    ["no flag", STAGING_HOST, { ...STAGING_ENV, STAGING_DEFAULT_PIN: undefined }, TEST_SHOP],
    ["flag \"true\"", STAGING_HOST, { ...STAGING_ENV, STAGING_DEFAULT_PIN: "true" }, TEST_SHOP],
    ["flag \" 1\"", STAGING_HOST, { ...STAGING_ENV, STAGING_DEFAULT_PIN: " 1" }, TEST_SHOP],
    ["STAGING unset", STAGING_HOST, { ...STAGING_ENV, STAGING: undefined }, TEST_SHOP],
    ["Host currencydeskos.com", "currencydeskos.com", STAGING_ENV, TEST_SHOP],
    ["Host www.currencydeskos.com", "www.currencydeskos.com", STAGING_ENV, TEST_SHOP],
    ["RENDER_EXTERNAL_HOSTNAME currencydesk.onrender.com", STAGING_HOST, { ...STAGING_ENV, RENDER_EXTERNAL_HOSTNAME: "currencydesk.onrender.com" }, TEST_SHOP],
    ["no Host", "", STAGING_ENV, TEST_SHOP],
    ["a real shop", STAGING_HOST, STAGING_ENV, { id: "tnt-harbour", isTestShop: false }],
    ["no shop", STAGING_HOST, STAGING_ENV, null],
    ["isTestShop \"true\"", STAGING_HOST, STAGING_ENV, { id: "tnt-harbour", isTestShop: "true" }],
  ])("is closed: %s", (_why, host, env, tenant) => {
    expect(stagingDefaultPinAllowed(host, env as NodeJS.ProcessEnv, tenant as { isTestShop: boolean })).toBe(false);
  });

  it("is closed when anything it reads throws", () => {
    const env = new Proxy({}, { get() { throw new Error("env read failed"); } }) as NodeJS.ProcessEnv;
    expect(stagingDefaultPinAllowed(STAGING_HOST, env, TEST_SHOP)).toBe(false);
    const tenant = { get isTestShop(): boolean { throw new Error("tenant read failed"); } };
    expect(stagingDefaultPinAllowed(STAGING_HOST, STAGING_ENV, tenant)).toBe(false);
  });
});

describe("the main application never takes an easy PIN", () => {
  it("refuses every same-digit PIN and allows 1122", () => {
    for (let d = 0; d <= 9; d++) expect(isWeakPin(String(d).repeat(4)), String(d).repeat(4)).toBe(true);
    expect(isWeakPin("1122")).toBe(false);
  });
});

describe("the PIN routes", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  const logs: string[] = [];
  const saved: Record<string, string | undefined> = {};
  let realShop = { tenantId: "", owner: "owner@harbour.example" };

  const staff = (staffId: string) =>
    handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId)).limit(1).then((r) => r[0]!);
  const testShop = (on: boolean) =>
    handle.db.update(schema.tenants).set({ isTestShop: on }).where(eq(schema.tenants.id, "tnt-yorkfx"));
  /* A session with no till, so a switch does not reach the ledger tables
     this embedded database does not have. */
  const signIn = async (staffId: string, tenantId = "tnt-yorkfx") => {
    const row = (await handle.db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.staffId, staffId), eq(schema.staffUsers.tenantId, tenantId))).limit(1))[0]!;
    return { cdos_session: (await createSession(handle.db, row.id, { workspaceId: null })).token };
  };
  const call = (cookies: Record<string, string>, method: "GET" | "POST", url: string, payload?: object, host = STAGING_HOST) =>
    app.inject({ method, url, cookies, payload, headers: { host } });
  const defaultRows = () =>
    handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "pin.staging_default_used"));

  beforeAll(async () => {
    for (const k of ["PGLITE_MEMORY", "SEED_PASSWORD", ...Object.keys(STAGING_ENV)]) saved[k] = process.env[k];
    Object.assign(process.env, { PGLITE_MEMORY: "1", SEED_PASSWORD: "yorkville" }, STAGING_ENV);
    vi.spyOn(console, "log").mockImplementation(() => {});
    handle = await createDb();
    await seed(handle.db);
    const stream = new Writable({ write(chunk, _enc, done) { logs.push(String(chunk)); done(); } });
    app = await buildApp(handle.db, {}, stream);
    const made = await provisionDesk(handle.db, {
      businessName: "Harbour Exchange", legalName: "Harbour Exchange Inc.", ownerName: "Harbour Owner", email: realShop.owner,
      slug: "harbour", plan: "pro", setup: {}, msbNumber: null, regulator: "FINTRAC", team: [],
    }, await hashPassword("yorkville"), "test");
    realShop = { ...realShop, tenantId: made.tenantId };
  });
  afterAll(async () => {
    await app.close(); await handle.close(); vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  beforeEach(async () => {
    await testShop(true);
    await handle.db.update(schema.staffUsers).set({ pinHash: null, pinMustChange: false }).where(eq(schema.staffUsers.tenantId, "tnt-yorkfx"));
    for (const id of ["a.singh", "m.costa", "j.masri"]) clearPinAttempts((await staff(id)).id);
    logs.length = 0;
  });

  it("a test shop on staging with the flag takes 0000, says so, and audits it without the PIN", async () => {
    const me = await signIn("a.singh");
    const got = await call(me, "GET", "/api/staff/pin");
    expect(got.json()).toMatchObject({ hasPin: false, defaultPin: true });
    const ok = await call(me, "POST", "/api/staff/pin/verify", { pin: "0000" });
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true, mustChange: false, defaultPin: true }]);
    const rows = await defaultRows();
    const verify = rows.find((r) => (r.detail as { route?: string }).route === "verify")!;
    const singh = await staff("a.singh");
    expect(verify).toMatchObject({ tenantId: "tnt-yorkfx", actorId: singh.id });
    expect(verify.detail).toMatchObject({ targetId: singh.id, route: "verify", host: STAGING_HOST });
    expect(typeof (verify.detail as { requestId?: unknown }).requestId).toBe("string");
    expect(rows.some((r) => (r.detail as { route?: string }).route === "get")).toBe(true);
    const audited = JSON.stringify(rows);
    expect(audited).not.toMatch(/"(pin|currentPin|newPin|pinHash)"/);
    expect(audited).not.toContain("0000");
    const warned = logs.filter((l) => l.includes("pin.staging_default_used"));
    expect(warned.length).toBeGreaterThan(0);
    expect(warned.join("\n")).not.toContain("0000");
  });

  it("a live Host gets 409 no_pin and no defaultPin", async () => {
    const me = await signIn("a.singh");
    const before = (await defaultRows()).length;
    for (const host of ["www.currencydeskos.com", "currencydeskos.com"]) {
      const res = await call(me, "POST", "/api/staff/pin/verify", { pin: "0000" }, host);
      expect([res.statusCode, res.json().error]).toEqual([409, "no_pin"]);
      expect((await call(me, "GET", "/api/staff/pin", undefined, host)).json()).not.toHaveProperty("defaultPin");
    }
    expect(await defaultRows()).toHaveLength(before);
  });

  it("a real shop on staging gets 409, and a test shop id in the body or query changes nothing", async () => {
    const me = await signIn(realShop.owner, realShop.tenantId);
    const res = await call(me, "POST", "/api/staff/pin/verify?tenantId=tnt-stg-test&isTestShop=true", { pin: "0000", tenantId: "tnt-stg-test", isTestShop: true });
    expect([res.statusCode, res.json().error]).toEqual([409, "no_pin"]);
    expect((await call(me, "GET", "/api/staff/pin?tenantId=tnt-stg-test")).json()).not.toHaveProperty("defaultPin");
  });

  it("works for anyone on the demo desk: another person's prompt and switching operators", async () => {
    await testShop(false);   // the staging demo shop, not a test shop
    const me = await signIn("a.singh");
    const other = await call(me, "POST", "/api/staff/pin/verify", { staffId: "m.costa", pin: "0000" });
    expect(other.statusCode, other.body).toBe(200);
    const sw = await call(me, "POST", "/api/auth/switch", { staffId: "m.costa", pin: "0000" });
    expect(sw.statusCode, sw.body).toBe(200);
    const rows = await defaultRows();
    expect(rows.some((r) => (r.detail as { route?: string }).route === "switch")).toBe(true);
    const live = await call(await signIn("a.singh"), "POST", "/api/auth/switch", { staffId: "m.costa", pin: "0000" }, "www.currencydeskos.com");
    expect(live.statusCode, live.body).toBe(409);
  });

  it("never stores 0000; after a person sets their own, both it and 0000 work, and a wrong one is 401", async () => {
    const me = await signIn("a.singh");
    const weak = await call(me, "POST", "/api/staff/pin", { pin: "0000", currentPin: "0000" });
    expect(weak.statusCode, weak.body).toBe(422);
    const set = await call(me, "POST", "/api/staff/pin", { pin: "4826", currentPin: "0000" });
    expect(set.statusCode, set.body).toBe(200);
    expect((await defaultRows()).some((r) => (r.detail as { route?: string }).route === "set")).toBe(true);
    for (const [pin, status] of [["0000", 200], ["4826", 200], ["1357", 401]] as const) {
      const res = await call(me, "POST", "/api/staff/pin/verify", { pin });
      expect(res.statusCode, `${pin} ${res.body}`).toBe(status);
    }
    expect((await call(me, "GET", "/api/staff/pin")).json()).toMatchObject({ hasPin: true, defaultPin: true });
    const sw = await call(await signIn("m.costa"), "POST", "/api/auth/switch", { staffId: "a.singh", pin: "0000" });
    expect(sw.statusCode, sw.body).toBe(200);
    const rows = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.tenantId, "tnt-yorkfx"));
    for (const row of rows) if (row.pinHash) expect(await verifyPassword("0000", row.pinHash), row.staffId).toBe(false);
  });

  it("wrong guesses count, and a right 0000 does not clear them", async () => {
    const me = await signIn("a.singh");
    for (const pin of ["1357", "2468"]) {
      const wrong = await call(me, "POST", "/api/staff/pin/verify", { pin });
      expect(wrong.statusCode, wrong.body).toBe(401);
    }
    const id = (await staff("a.singh")).id;
    expect(lockState(id).remaining).toBe(3);
    expect((await call(me, "POST", "/api/staff/pin/verify", { pin: "0000" })).statusCode).toBe(200);
    expect(lockState(id).remaining).toBe(3);
    for (const pin of ["1357", "2468", "3579"]) await call(me, "POST", "/api/staff/pin/verify", { pin });
    const locked = await call(me, "POST", "/api/staff/pin/verify", { pin: "0000" });
    expect(locked.statusCode, locked.body).toBe(429);
  });
});

/* is_test_shop is written only where a shop is provisioned, and that only
   takes true from a staging fresh-shop signup. No route reads it from a
   request body. */
describe("is_test_shop", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "migrations" ? [] : files(p)) : p.endsWith(".ts") ? [p] : [];
  });
  it("is set only by provisioning, from the two staging fresh-shop doors", () => {
    const root = join(here, "../src");
    /* A read aliases the column (isTestShop: schema.tenants.isTestShop). Anything else is a write. */
    const writers = files(root).filter((p) => /isTestShop\s*:(?!\s*schema\.tenants\.isTestShop)|isTestShop\s*=(?!=)|is_test_shop\s*=/.test(readFileSync(p, "utf8")));
    expect(writers.map((p) => p.slice(root.length + 1)).sort()).toEqual(["db/schema.ts", "onboarding/provision.ts", "routes/onboarding-public.ts", "routes/signup.ts"]);
    expect(readFileSync(join(root, "routes/signup.ts"), "utf8")).toMatch(/isTestShop: stagingTestShop,/);
    expect(readFileSync(join(root, "onboarding/provision.ts"), "utf8")).toMatch(/isTestShop: spec\.isTestShop === true,/);
    expect(readFileSync(join(root, "routes/onboarding-public.ts"), "utf8")).toMatch(/if \(stagingSlug\) \{\s+spec\.isTestShop = true;/);
  });
});

/* The browser never decides or sends the default. */
describe("the desk bundle", () => {
  it("holds no 0000 PIN and sends only what was typed", () => {
    const bundle = readFileSync(join(here, "../../web/app/os.js"), "utf8");
    expect(bundle).not.toMatch(/(?:pin|Pin|PIN|expected|exp)["']?\s*[:=]\s*(?:[^,;)\n]{0,40}\?\s*)?["']0000["']/);
    expect(bundle).not.toMatch(/===\s*["']0000["']|["']0000["']\s*===/);
    const prompt = readFileSync(join(here, "../../os-src/cdos-base.jsx"), "utf8");
    expect(prompt).toMatch(/JSON\.stringify\(staffId \? \{ staffId: staffId, pin: val \} : \{ pin: val \}\)/);
  });
});
