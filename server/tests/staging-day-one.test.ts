/* Staging "Start on Day 1" (POST /api/staging/day-one).

   One press makes a brand-new synthetic shop through the real v2.1 sign-up
   services, in the page's order (reservation, password, on-screen code,
   PIN, chapters, signature, staging plan), and stops where a staging owner
   stands just before Open. The page then asks the existing /resume,
   /staging-open and /open on the enrolment cookie it was given, and lands
   on Day 1 as the owner of a test shop.

   Closed: live never registers it; a live, forwarded, preview or missing
   Host is 404; a cross-site or non-JSON post is 403; an unmarked database
   is 503 and writes nothing. Every press is a new shop, under the shared
   per-IP limit, a /64 bucket for IPv6 and a process-wide hourly ceiling.
   Nothing reaches Stripe, a mailer, the network or a log line, and the
   database keeps only hashes of the password, PIN and code. */
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, like, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { verifyPassword } from "../src/auth/password.js";
import { stagingDoorOpen } from "../src/auth/staging-runtime.js";
import * as email from "../src/email.js";
import * as billing from "../src/billing/stripe.js";
import * as signupOpen from "../src/onboarding/signup-open.js";
import * as pipeline from "../src/onboarding/pipeline.js";
import { claimedCount } from "../src/routes/early-access.js";
import {
  allowDayOne, allowFreshShop, DAY_ONE_HOURLY_MAX, FRESH_SHOP_IP_MAX, freshShopTracked, resetFreshShopThrottle,
} from "../src/routes/staging-fresh-shop.js";
import { dayOneApplication } from "../src/onboarding/staging-day-one.js";
import { loadAccount } from "../src/onboarding/signup-account.js";
import { SERVICE_AGREEMENT_SOURCE_HASH } from "../src/onboarding/signup-open.js";
import { stagingFixtureOwner, stagingFixtureRow } from "../src/onboarding/signup-staging.js";

const HOST = "staging.currencydeskos.com";
const URL_DAY_ONE = "/api/staging/day-one";
const ID = /^CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
const EMAIL = /^owner\+([0-9a-f]{8})@staging\.invalid$/;
const PASSWORD = /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{4}$/;
const AGREE = { termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH, agreed: true };
const saved = { STAGING: process.env.STAGING, RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME, PGLITE_MEMORY: process.env.PGLITE_MEMORY, IS_PULL_REQUEST: process.env.IS_PULL_REQUEST };

let handle: DbHandle;
let app: FastifyInstance;
const logs: string[] = [];
const consoleLines: string[] = [];
const fetched: string[] = [];

type Jar = Record<string, string>;
type Reply = Awaited<ReturnType<FastifyInstance["inject"]>>;
const keep = (jar: Jar, res: Reply): Reply => { for (const c of res.cookies) { if (c.value) jar[c.name] = c.value; else delete jar[c.name]; } return res; };
async function call(jar: Jar, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = { host: HOST }, remoteAddress?: string) {
  return keep(jar, await app.inject({
    method, url, headers, cookies: { ...jar },
    ...(payload === undefined ? {} : { payload: payload as object }),
    ...(remoteAddress ? { remoteAddress } : {}),
  }));
}
const press = (jar: Jar = {}, headers: Record<string, string> = { host: HOST }, remoteAddress?: string) => call(jar, "POST", URL_DAY_ONE, {}, headers, remoteAddress);

type DayOne = { ok: true; cdId: string; operatingName: string; signIn: { email: string; password: string; pin: string } };

/** Press, then what the page does next: resume, staging-open, open. */
async function throughOpen(jar: Jar = {}) {
  const res = await press(jar);
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as DayOne;
  const base = `/api/onboarding/${body.cdId}`;
  const resume = await call(jar, "GET", `${base}/resume`);
  expect(resume.statusCode, resume.body).toBe(200);
  const opened = await call(jar, "POST", `${base}/staging-open`, AGREE);
  expect(opened.statusCode, opened.body).toBe(200);
  const inside = await call(jar, "POST", `${base}/open`, {});
  expect(inside.statusCode, inside.body).toBe(200);
  return { body, base, resume: resume.json(), tenantId: inside.json().tenantId as string, jar };
}

function setRuntime(flag: string | undefined, external: string) {
  if (flag === undefined) delete process.env.STAGING; else process.env.STAGING = flag;
  process.env.RENDER_EXTERNAL_HOSTNAME = external;
}
async function mark(rows: string[]) {
  await handle.db.execute(sql`DELETE FROM db_environment`);
  for (const r of rows) await handle.db.execute(sql`INSERT INTO db_environment (environment) VALUES (${r})`);
}
/** What a refused press must not have written. */
async function written() {
  return {
    enquiries: (await handle.db.select().from(schema.enquiries).where(like(schema.enquiries.email, "%@staging.invalid"))).length,
    accounts: (await handle.db.select().from(schema.signupAccounts)).length,
    tenants: (await handle.db.select().from(schema.tenants)).length,
    staff: (await handle.db.select().from(schema.staffUsers)).length,
  };
}
async function enquiryByCdId(cdId: string) {
  return (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.cdId, cdId)))[0]!;
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  delete process.env.IS_PULL_REQUEST;
  setRuntime("1", HOST);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
    fetched.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    throw new Error("no network in tests");
  });
  handle = await createDb();
  await seed(handle.db);
  /* PGlite does not run the SQL migration list: the insert-only table as migration 060 names it */
  await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS db_environment (environment text NOT NULL)`);
  app = await buildApp(handle.db, {}, new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await handle.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});
beforeEach(async () => {
  setRuntime("1", HOST);
  delete process.env.IS_PULL_REQUEST;
  resetFreshShopThrottle();
  await mark(["staging"]);
});

describe("closed everywhere but the staging door", () => {
  it("is not registered unless STAGING is exactly 1", async () => {
    for (const flag of [undefined, "0", "true"]) {
      setRuntime(flag, HOST);
      const live = await buildApp(handle.db, {}, new Writable({ write(_c, _e, cb) { cb(); } }));
      try {
        expect(live.hasRoute({ method: "POST", url: URL_DAY_ONE }), String(flag)).toBe(false);
      } finally {
        await live.close();
      }
    }
  });

  it("is 404 for a live, forwarded, preview or missing Host, and on a live runtime; nothing is written", async () => {
    const before = await written();
    for (const headers of <Record<string, string>[]>[
      { host: "www.currencydeskos.com" },
      { host: "currencydeskos.com", "x-forwarded-host": HOST },
      { host: "www.currencydeskos.com", forwarded: `host=${HOST}` },
      { host: "currencydesk-staging-pr-12.onrender.com" },
      { host: "localhost" },
      { host: "" },
    ]) {
      const res = await press({}, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(404);
      expect(res.cookies.map((c) => c.name)).not.toContain("cd_enrol");
    }
    /* the door reads the first Host of an array, never a later one */
    expect(stagingDoorOpen({ host: ["www.currencydeskos.com", HOST] })).toBe(false);
    expect(stagingDoorOpen({ host: [HOST, "www.currencydeskos.com"] })).toBe(true);
    /* a live service hostname, or STAGING unset after boot */
    setRuntime("1", "www.currencydeskos.com");
    expect((await press()).statusCode).toBe(404);
    setRuntime(undefined, HOST);
    expect((await press()).statusCode).toBe(404);
    expect(await written()).toEqual(before);
  });

  it("opens for a staging Host with a port and a trailing dot", async () => {
    const res = await press({}, { host: "STAGING.currencydeskos.com.:443" });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("refuses a cross-site or non-JSON post with 403 and writes nothing", async () => {
    const before = await written();
    const cases: { headers: Record<string, string>; payload?: string }[] = [
      { headers: { host: HOST, "content-type": "text/plain" }, payload: "{}" },
      { headers: { host: HOST, "content-type": "application/x-www-form-urlencoded" }, payload: "a=1" },
      { headers: { host: HOST, "content-type": "multipart/form-data; boundary=x" }, payload: "--x--" },
      { headers: { host: HOST } },
      { headers: { host: HOST, "content-type": "application/json", "sec-fetch-site": "cross-site" }, payload: "{}" },
      { headers: { host: HOST, "content-type": "application/json", "sec-fetch-site": "same-site" }, payload: "{}" },
      { headers: { host: HOST, "content-type": "application/json", "sec-fetch-site": "none" }, payload: "{}" },
      { headers: { host: HOST, "content-type": "application/json", origin: "https://evil.example" }, payload: "{}" },
      { headers: { host: HOST, "content-type": "application/json", origin: "null" }, payload: "{}" },
      { headers: { host: HOST, "content-type": "application/json", origin: `https://${HOST}.evil.example` }, payload: "{}" },
      { headers: { host: HOST, "content-type": "application/json", origin: `https://${HOST}:8443` }, payload: "{}" },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: "POST", url: URL_DAY_ONE, headers: c.headers, ...(c.payload === undefined ? {} : { payload: c.payload }) });
      expect(res.statusCode, JSON.stringify(c)).toBe(403);
      expect(res.json().error).toBe("cross_site");
      expect(res.cookies.map((k) => k.name)).not.toContain("cd_enrol");
    }
    /* a live host is still 404 first, whatever it sends */
    const live = await app.inject({ method: "POST", url: URL_DAY_ONE, headers: { host: "www.currencydeskos.com", "content-type": "text/plain" }, payload: "{}" });
    expect(live.statusCode).toBe(404);
    expect(await written()).toEqual(before);
    /* the browser's own same-origin JSON post */
    const ok = await press({}, { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin" });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("an unmarked database is 503 and writes nothing", async () => {
    for (const rows of [[], ["production"], ["staging", "staging"]]) {
      await mark(rows);
      const before = await written();
      const res = await press();
      expect(res.statusCode, JSON.stringify(rows)).toBe(503);
      expect(res.json()).toEqual({ error: "staging_unavailable", detail: "This staging door can't open a shop just now. No desk was opened." });
      expect(res.cookies.map((c) => c.name)).not.toContain("cd_enrol");
      expect(await written()).toEqual(before);
    }
    expect(logs.join("\n")).toContain('"reason":"db_unmarked"');
  });
});

describe("one press, one new test shop on Day 1", () => {
  it("runs the real services and leaves the page at Open; the page's own calls open the desk as the owner", async () => {
    const config = vi.spyOn(billing, "stripeBillingConfig").mockReturnValue({
      secretKey: "unused-test-key", prices: {
        basic: { monthly: undefined, annual: undefined },
        pro: { monthly: undefined, annual: undefined },
        premium: { monthly: undefined, annual: undefined },
      },
    });
    const factory = vi.spyOn(billing, "signupStripeClient").mockImplementation(() => { throw new Error("Synthetic shop reached Stripe"); });
    const claimedBefore = await claimedCount(handle.db);
    const fetchedBefore = fetched.length;
    try {
      const jar: Jar = {};
      const res = await press(jar);
      expect(res.statusCode, res.body).toBe(201);
      /* exactly these keys: no enrolment token, code or reference in page memory */
      const body = res.json() as DayOne;
      expect(Object.keys(body).sort()).toEqual(["cdId", "ok", "operatingName", "signIn"]);
      expect(Object.keys(body.signIn).sort()).toEqual(["email", "password", "pin"]);
      expect(body.ok).toBe(true);
      expect(body.cdId).toMatch(ID);
      expect(body.signIn.email).toMatch(EMAIL);
      expect(body.signIn.password).toMatch(PASSWORD);
      expect(body.signIn.pin).toMatch(/^[0-9]{4}$/);
      expect(body.signIn.pin).not.toBe("1234");
      expect(body.signIn.pin).not.toMatch(/^(\d)\1{3}$/);
      const hex = EMAIL.exec(body.signIn.email)![1]!;
      expect(body.operatingName).toBe(`Staging Shop ${hex.slice(0, 4).toUpperCase()}`);
      expect(String(res.headers["cache-control"])).toContain("no-store");
      /* the ordinary enrolment cookie, and no desk session yet */
      const enrol = res.cookies.find((c) => c.name === "cd_enrol")!;
      expect(enrol).toMatchObject({ path: "/api/onboarding", httpOnly: true, sameSite: "Lax" });
      expect(res.cookies.map((c) => c.name)).not.toContain("cdos_session");

      /* the reservation, exactly where a staging owner stands before Open */
      const row = await enquiryByCdId(body.cdId);
      expect(stagingFixtureRow(row)).toBe(true);
      expect(row).toMatchObject({ status: "invited", kind: "early_access", email: body.signIn.email, name: "Staging Owner", charterNo: null });
      expect(row.details).toMatchObject({ slug: `stg-${hex}`, stagingFresh: true, shopName: body.operatingName, jurisdiction: "CA", province: "ON" });
      const account = await loadAccount(handle.db, row.id);
      expect(account.state).toBe("verified");
      expect(account.pinHash).toMatch(/^\$argon2id\$/);
      expect(account.confirmedAt).toBeTruthy();
      expect(account.confirmedName).toBe("Staging Owner");
      expect(account.planChoice).toMatchObject({ staging: true, agreed: false, plan: "ai", term: "monthly", locations: 1, call: false, website: false });
      expect(account.stripeCustomerId).toBeNull();
      expect(account.setupIntentId).toBeNull();

      /* the page's own calls, on the cookie it was given */
      const base = `/api/onboarding/${body.cdId}`;
      const resume = await call(jar, "GET", `${base}/resume`);
      expect(resume.statusCode, resume.body).toBe(200);
      expect(resume.json()).toMatchObject({
        state: "verified", pinSet: true, saved: true, lastStep: "20-team",
        answers: { operatingName: body.operatingName, city: "Toronto", region: "ON", currencies: ["USD", "EUR"], complianceMode: "me", idOver: "3000", team: [] },
        you: { name: "Staging Owner" },
        callPreference: { call: false },
      });
      const opened = await call(jar, "POST", `${base}/staging-open`, AGREE);
      expect(opened.statusCode, opened.body).toBe(200);
      const inside = await call(jar, "POST", `${base}/open`, {});
      expect(inside.statusCode, inside.body).toBe(200);
      expect(jar.cdos_session).toBeTruthy();
      expect(jar.cd_enrol).toBeUndefined();
      const tenantId = inside.json().tenantId as string;
      const home = await call(jar, "GET", "/api/tenant");
      expect(home.statusCode, home.body).toBe(200);
      expect(home.body).toContain(tenantId);

      /* a test shop on its own stg- address, with no card or billing row */
      const tenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0]!;
      expect(tenant.isTestShop).toBe(true);
      expect(tenant.siteSlug).toBe(`stg-${hex}`);
      const setup = tenant.setup as { signup?: { version?: string; vaultCount?: unknown; vaultCountStatus?: string } };
      expect(setup.signup).toMatchObject({
        version: "2.1", vaultCountStatus: "pending-ledger-integration",
        vaultCount: { CAD: { mode: "total", total: "2000.00" }, USD: { mode: "total", total: "500.00" }, EUR: { mode: "total", total: "300.00" } },
      });
      const entity = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, tenantId)))[0]!;
      expect(entity.idThreshold).toBeNull();
      expect(await handle.db.select().from(schema.stripeCustomers).where(eq(schema.stripeCustomers.tenantId, tenantId))).toHaveLength(0);
      const after = await loadAccount(handle.db, row.id);
      expect(after.state).toBe("active");
      expect(after.stripeCustomerId).toBeNull();
      expect(after.setupIntentId).toBeNull();
      const agreements = await handle.db.select().from(schema.signupAgreements).where(eq(schema.signupAgreements.enquiryId, row.id));
      expect(agreements.filter((a) => a.kind === "desk")).toHaveLength(1);
      const plans = agreements.filter((a) => a.kind === "plan");
      expect(plans).toHaveLength(1);
      expect(plans[0]!.record).toMatchObject({ agreed: true, staging: true, setupIntentId: null, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH });

      /* the owner holds the shown password, the shown PIN and the CD ID */
      const owner = (await handle.db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, body.signIn.email))))[0]!;
      expect(owner.cdId).toBe(body.cdId);
      expect(owner.role).toBe("administrator");
      expect(owner.mustChangePassword).toBe(false);
      expect(await verifyPassword(body.signIn.password, owner.passwordHash)).toBe(true);
      expect(await verifyPassword(body.signIn.pin, owner.pinHash!)).toBe(true);
      expect(await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.tenantId, tenantId))).toHaveLength(1);

      const audits = await handle.db.select().from(schema.auditEvents);
      expect(audits.filter((a) => a.tenantId === tenantId && a.action === "signup.completed")).toHaveLength(1);
      expect(audits.filter((a) => a.action === "staging.day_one" && (a.detail as { enquiryId?: string }).enquiryId === row.id)).toHaveLength(1);
      expect(await claimedCount(handle.db)).toBe(claimedBefore);

      /* nothing reached a card processor, a mailer or the network */
      expect(factory).not.toHaveBeenCalled();
      expect(fetched.length).toBe(fetchedBefore);
      expect([...logs, ...consoleLines].join("\n")).not.toContain("[email");
    } finally {
      factory.mockRestore(); config.mockRestore();
    }
  });

  it("the owner comes back with the shown email and password: the staging owner proof holds and the sign-in code is on screen", async () => {
    const { body, tenantId, jar } = await throughOpen();
    expect(await stagingFixtureOwner(handle.db, { host: HOST }, body.signIn.email, tenantId)).toBe(true);
    expect((await call(jar, "POST", "/api/auth/logout", {})).statusCode).toBeLessThan(300);
    expect((await call(jar, "GET", "/api/tenant")).statusCode).toBe(401);
    const start = await call(jar, "POST", "/api/auth/login/start", { staffId: body.signIn.email, password: body.signIn.password });
    expect(start.statusCode, start.body).toBe(200);
    const code = start.json().code as string;
    expect(code).toMatch(/^\d{6}$/);
    expect((await call(jar, "POST", "/api/auth/login/verify", { staffId: body.signIn.email, code })).statusCode).toBe(200);
    expect((await call(jar, "GET", "/api/tenant")).statusCode).toBe(200);
  });

  it("every press is a new shop", async () => {
    const one = await throughOpen();
    const two = await throughOpen();
    expect(two.body.cdId).not.toBe(one.body.cdId);
    expect(two.body.signIn.email).not.toBe(one.body.signIn.email);
    expect(two.body.signIn.password).not.toBe(one.body.signIn.password);
    expect(two.tenantId).not.toBe(one.tenantId);
    const slugs = (await handle.db.select().from(schema.tenants)).filter((t) => t.id === one.tenantId || t.id === two.tenantId).map((t) => t.siteSlug);
    expect(new Set(slugs).size).toBe(2);
    /* the second jar's desk session is its own shop's */
    const mine = await call(two.jar, "GET", "/api/tenant");
    expect(mine.body).toContain(two.tenantId);
    expect(mine.body).not.toContain(one.tenantId);
  });
});

describe("limits", () => {
  it("shares the per-IP limit with Start a fresh shop", async () => {
    const ip = "198.51.100.7";
    for (let k = 0; k < FRESH_SHOP_IP_MAX - 1; k++) {
      expect((await call({}, "POST", "/api/staging/fresh-onboarding", {}, { host: HOST }, ip)).statusCode).toBe(201);
    }
    expect((await press({}, { host: HOST }, ip)).statusCode).toBe(201);
    const before = await written();
    const slow = await press({}, { host: HOST }, ip);
    expect(slow.statusCode).toBe(429);
    expect(slow.json()).toEqual({ error: "slow_down" });
    expect((await call({}, "POST", "/api/staging/fresh-onboarding", {}, { host: HOST }, ip)).statusCode).toBe(429);
    expect(await written()).toEqual(before);
  });

  it("holds a process-wide hourly ceiling across many addresses", async () => {
    for (let k = 0; k < DAY_ONE_HOURLY_MAX; k++) expect(allowDayOne(`203.0.113.${k + 1}`), String(k)).toBe(true);
    expect(allowDayOne("203.0.113.250")).toBe(false);
    expect(allowDayOne("2001:db8:aaaa:bbbb::1")).toBe(false);
    const before = await written();
    const slow = await press({}, { host: HOST }, "198.51.100.99");
    expect(slow.statusCode).toBe(429);
    expect(await written()).toEqual(before);
    /* the ceiling is Start on Day 1's own: a fresh shop from a new address still starts */
    expect(allowFreshShop("198.51.100.100")).toBe(true);
    resetFreshShopThrottle();
    expect(allowDayOne("203.0.113.250")).toBe(true);
  });

  it("counts an IPv6 /64 as one address, keeps IPv4 as it was, and forgets expired keys", async () => {
    for (let k = 0; k < FRESH_SHOP_IP_MAX; k++) {
      expect(allowFreshShop(k % 2 ? "2001:db8:1:2::1" : "2001:DB8:1:2:ffff:ffff:ffff:fffe"), String(k)).toBe(true);
    }
    expect(allowFreshShop("2001:db8:1:2::abcd")).toBe(false);
    expect(allowFreshShop("2001:0db8:0001:0002:0:0:0:9")).toBe(false);
    expect(allowFreshShop("2001:db8:1:3::1")).toBe(true);
    for (let k = 0; k < FRESH_SHOP_IP_MAX; k++) expect(allowFreshShop("203.0.113.1")).toBe(true);
    expect(allowFreshShop("203.0.113.1")).toBe(false);
    expect(allowFreshShop("203.0.113.2")).toBe(true);
    resetFreshShopThrottle();
    expect(freshShopTracked()).toBe(0);
    expect(allowFreshShop("2001:db8:1:2::1")).toBe(true);
    expect(allowFreshShop("203.0.113.1")).toBe(true);
    /* an hour later, a new address does not keep the old ones */
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      expect(allowFreshShop("203.0.113.3")).toBe(true);
      expect(freshShopTracked()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the same reservation the ticket path writes", () => {
  it("matches a fresh-onboarding application column for column, except the call stop Day 1 records", async () => {
    const claimedBefore = await claimedCount(handle.db);
    /* the ticket path, with the same application */
    const door = await call({}, "POST", "/api/staging/fresh-onboarding", {});
    expect(door.statusCode).toBe(201);
    const { start, email: ticketEmail } = door.json() as { start: string; email: string };
    const hex = EMAIL.exec(ticketEmail)![1]!;
    const applied = await call({}, "POST", "/api/enquiries", {
      kind: "early_access", form: "early-access-v2.1", email: "typed@example.com", name: "Staging Owner",
      stagingDoor: new URL(start, "https://x").searchParams.get("door"),
      details: dayOneApplication({ slug: `stg-${hex}`, email: ticketEmail, hex }),
      contactContext: { timezone: "America/Toronto" },
    });
    expect(applied.statusCode, applied.body).toBe(201);
    const ticket = await enquiryByCdId(applied.json().cdId as string);
    /* Day 1 */
    const res = await press();
    expect(res.statusCode, res.body).toBe(201);
    const day = await enquiryByCdId((res.json() as DayOne).cdId);

    const perRow = ["id", "reference", "email", "cdId", "details", "createdAt", "decidedAt", "handledAt"] as const;
    const rest = (r: typeof day) => Object.fromEntries(Object.entries(r).filter(([k]) => !(perRow as readonly string[]).includes(k)));
    expect(rest(day)).toEqual(rest(ticket));
    expect(day).toMatchObject({ status: "invited", kind: "early_access", charterNo: null, doNotContact: true, waitlistReason: null, inviteCode: null, placeInLine: null, decidedBy: "system" });
    const own = ["shopName", "workspace", "slug"];
    const shared = (d: Record<string, unknown> | null) => Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => !own.includes(k)));
    expect(Object.keys(day.details ?? {}).sort()).toEqual(Object.keys(ticket.details ?? {}).sort());
    expect(shared(day.details)).toEqual(shared(ticket.details));
    expect(stagingFixtureRow(day)).toBe(true);
    expect(stagingFixtureRow(ticket)).toBe(true);

    for (const r of [day, ticket]) {
      expect(await handle.db.select().from(schema.enquiryContactConsents).where(eq(schema.enquiryContactConsents.enquiryId, r.id))).toHaveLength(0);
      expect(await handle.db.select().from(schema.enquiryGrowthJobs).where(eq(schema.enquiryGrowthJobs.enquiryId, r.id))).toHaveLength(0);
      expect(await handle.db.select().from(schema.enquiryGrowthEvents).where(eq(schema.enquiryGrowthEvents.enquiryId, r.id))).toHaveLength(0);
    }
    /* the page's plan step with the call off records a stop; the ticket row has not reached its plan */
    expect(await handle.db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, ticket.id))).toHaveLength(0);
    const calls = await handle.db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, day.id));
    expect(calls.map((c) => c.event)).toEqual(["stop"]);
    expect(await claimedCount(handle.db)).toBe(claimedBefore);
  });
});

describe("nothing secret is kept or said", () => {
  it("logs, console, network and the database never hold the password, the PIN or the code", async () => {
    const dump = async () => {
      const tables = (await handle.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => String(r.table_name));
      const all: Record<string, unknown[]> = {};
      for (const t of tables) all[t] = (await handle.db.execute(sql.raw(`SELECT * FROM "${t}"`))).rows;
      return all;
    };
    const leaves = (v: unknown, out: Set<string>): Set<string> => {
      if (v === null || v === undefined) return out;
      if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") { out.add(String(v)); return out; }
      if (v instanceof Date) { out.add(v.toISOString()); return out; }
      if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) leaves(x, out);
      return out;
    };
    const known = leaves(await dump(), new Set());
    const makeCode = vi.spyOn(email, "makeCode");
    const said = logs.length + consoleLines.length;
    const fetchedBefore = fetched.length;
    try {
      const { body, tenantId } = await throughOpen();
      const codes = makeCode.mock.results.map((r) => String(r.value));
      expect(codes.length).toBeGreaterThanOrEqual(1);
      for (const c of codes) expect(c).toMatch(/^\d{6}$/);
      const { password, pin, email: ownerEmail } = body.signIn;

      /* Timings and clocks are digits that mean nothing; a short PIN must not match inside them. */
      const scrub = (line: string) => {
        try {
          const o = JSON.parse(line) as Record<string, unknown> & { req?: Record<string, unknown> };
          delete o.time; delete o.responseTime; delete o.pid;
          if (o.req) delete o.req.remotePort;
          return JSON.stringify(o);
        } catch { return line; }
      };
      const text = [...logs.flatMap((l) => l.split("\n")).map(scrub), ...consoleLines].join("\n");
      expect(logs.length + consoleLines.length).toBeGreaterThan(said);
      expect(text).not.toContain(password);
      expect(text).not.toContain(ownerEmail);
      expect(text).not.toContain(body.cdId);
      expect(text).not.toMatch(new RegExp(`(?<![0-9])${pin}(?![0-9])`));
      for (const c of codes) expect(text).not.toMatch(new RegExp(`(?<![0-9])${c}(?![0-9])`));
      expect(text).not.toContain("[email");
      expect(fetched.length).toBe(fetchedBefore);

      const now = await dump();
      expect(JSON.stringify(now, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(password);
      const fresh = [...leaves(now, new Set())].filter((l) => !known.has(l));
      expect(fresh).not.toContain(pin);
      for (const c of codes) expect(fresh).not.toContain(c);
      /* what is kept is a hash */
      const row = await enquiryByCdId(body.cdId);
      const credential = (await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, row.id)))[0]!;
      expect(credential.passwordHash).toMatch(/^\$argon2id\$/);
      const account = await loadAccount(handle.db, row.id);
      expect(account.pinHash).toMatch(/^\$argon2id\$/);
      expect(account.codeHash).toBeNull();
      const owner = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.tenantId, tenantId)))[0]!;
      expect(owner.passwordHash).toMatch(/^\$argon2id\$/);
      expect(owner.pinHash).toMatch(/^\$argon2id\$/);
    } finally {
      makeCode.mockRestore();
    }
  });

  it("a step that throws is a bounded 503: no message, value or stack leaves the server", async () => {
    const secret = "owner+deadbeef@staging.invalid detail 4821";
    const plan = vi.spyOn(signupOpen, "prepareStagingPlan").mockRejectedValue(new Error(secret));
    try {
      const res = await press();
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "staging_unavailable", detail: "This staging door can't open a shop just now. No desk was opened." });
      expect(res.cookies.map((c) => c.name)).not.toContain("cd_enrol");
      expect(logs.join("\n")).toContain('"reason":"step_plan"');
      expect([...logs, ...consoleLines].join("\n")).not.toContain(secret);
    } finally {
      plan.mockRestore();
    }
  });

  it("an invitation that does not land is refused before any credential is saved", async () => {
    const move = vi.spyOn(pipeline, "moveTo").mockResolvedValueOnce({ ok: false, error: "changed", detail: "x" } as never);
    try {
      const accounts = (await handle.db.select().from(schema.signupAccounts)).length;
      const res = await press();
      expect(res.statusCode).toBe(503);
      expect(logs.join("\n")).toContain('"reason":"step_invite"');
      expect((await handle.db.select().from(schema.signupAccounts)).length).toBe(accounts);
    } finally {
      move.mockRestore();
    }
  });
});
