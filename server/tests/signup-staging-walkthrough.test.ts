/* Sign-up v2.1 on staging, the synthetic shop (onboarding/signup-staging.ts).

   The whole walkthrough through the real app: the staging door's ticket, the
   Early Access application, the credential with its code handed back on
   screen, the PIN, the chapters, the signature, the no-card Open as a test
   shop, the real session and Home, sign out, and the existing staging sign-in
   back in. Then every gate refusing on its own: a spoofed or live host, a live
   runtime, an unmarked database, an ordinary reservation, an unbound browser,
   no enrolment session, a stale signature and an invalid plan. Nothing reaches
   Stripe or the mailer, and a retried Open makes one desk. */
import { Writable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { resetFreshShopThrottle } from "../src/routes/staging-fresh-shop.js";
import { STAGING_DOOR_REASON } from "../src/routes/early-access.js";
import { loadAccount } from "../src/onboarding/signup-account.js";
import { openStagingDesk, SERVICE_AGREEMENT_SOURCE_HASH } from "../src/onboarding/signup-open.js";
import { moveTo } from "../src/onboarding/pipeline.js";
import { databaseMarkedStaging, stagingFixtureOwner, stagingFixtureRow } from "../src/onboarding/signup-staging.js";
import { forget as forgetCooldown } from "../src/cooldown.js";
import * as emailTransport from "../src/email.js";
import { hashCode } from "../src/email.js";
import * as billing from "../src/billing/stripe.js";

const HOST = "staging.currencydeskos.com";
const PASSWORD = "four plain words here";
const saved = { STAGING: process.env.STAGING, RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME, PGLITE_MEMORY: process.env.PGLITE_MEMORY, IS_PULL_REQUEST: process.env.IS_PULL_REQUEST };
let handle: DbHandle;
let app: FastifyInstance;
const logs: string[] = [];
const consoleLines: string[] = [];
const fetched: string[] = [];

type Jar = Record<string, string>;
const keep = <T extends { cookies: { name: string; value: string }[] }>(jar: Jar, res: T): T => { for (const c of res.cookies) { if (c.value) jar[c.name] = c.value; else delete jar[c.name]; } return res; };
async function call(jar: Jar, method: "GET" | "POST" | "PUT", url: string, payload?: object, headers: Record<string, string> = { host: HOST }) {
  return keep(jar, await app.inject({ method, url, headers, cookies: { ...jar }, ...(payload === undefined ? {} : { payload }) }));
}

const STEPS = [
  ["08-shop-name", { operatingName: "Harbour Test", bizName: "Harbour Test Inc." }],
  ["09-address", { street: "1420 Dundas St W", city: "Toronto", region: "ON", postal: "M6J 1Y5", addrManual: true }],
  ["14-currencies", { currencies: ["USD", "EUR"] }],
  ["18-officer", { complianceMode: "me" }],
  ["19-idline", { idOver: "1000" }],
  ["20-team", { team: [{ first: "Samira", last: "Haddad", role: "Manager", email: "samira@harbour.test" }] }],
] as const;
const PLAN = { plan: "ai", term: "monthly", extras: { brief: true, call: false, website: false, setupWeek: false } };
const AGREE = { termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH, agreed: true };

let seq = 0;
const ALPHA = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** A reservation as the staging door's application writes it (routes/enquiries.ts), or an ordinary one. */
async function reservation(kind: "fixture" | "ordinary", tweak: (row: Record<string, unknown>) => void = () => {}) {
  seq++;
  const hex = randomBytes(4).toString("hex");
  const cdId = `CD-HARB-${ALPHA[seq % 31]}${ALPHA[(seq * 3) % 31]}${ALPHA[(seq * 7) % 31]}${ALPHA[(seq * 11) % 31]}`;
  const row: Record<string, unknown> = {
    id: `enq-${randomUUID()}`, reference: `CD-S${String(seq).padStart(5, "0")}`, kind: "early_access", status: "invited", cdId, name: "Staging Owner",
    email: kind === "fixture" ? `owner+${hex}@staging.invalid` : `owner${seq}@harbour.test`,
    details: { firstName: "Staging", lastName: "Owner", shopName: "Harbour Test", jurisdiction: "CA", province: "ON", workspace: `harbour-${seq}.currencydeskos.com`, phone: "+1 416 555 0148",
      ...(kind === "fixture" ? { stagingFresh: true, slug: `stg-${hex}` } : {}) },
    ...(kind === "fixture" ? { doNotContact: true, doNotContactReason: STAGING_DOOR_REASON } : {}),
  };
  tweak(row);
  await handle.db.insert(schema.enquiries).values(row as typeof schema.enquiries.$inferInsert);
  return { id: row.id as string, cdId, email: row.email as string, base: `/api/onboarding/${cdId}` };
}

/** Code in hand: credential, verify, PIN, chapters, signature. */
async function signed(jar: Jar, base: string) {
  const saved = await call(jar, "POST", `${base}/password`, { password: PASSWORD, confirm: PASSWORD });
  expect(saved.statusCode, saved.body).toBe(200);
  const code = saved.json().stagingCode as string;
  expect(code).toMatch(/^\d{6}$/);
  expect((await call(jar, "POST", `${base}/email/verify`, { code })).statusCode).toBe(200);
  expect((await call(jar, "POST", `${base}/pin`, { pin: "4821", confirm: "4821" })).statusCode).toBe(200);
  for (const [step, answers] of STEPS) expect((await call(jar, "PUT", `${base}/answers`, { step, answers })).statusCode).toBe(200);
  expect((await call(jar, "POST", `${base}/confirm`, { signed: true, name: "Staging Owner" })).statusCode).toBe(200);
  return code;
}

function setRuntime(flag: string | undefined, external: string) {
  if (flag === undefined) delete process.env.STAGING; else process.env.STAGING = flag;
  process.env.RENDER_EXTERNAL_HOSTNAME = external;
}
async function mark(rows: string[]) {
  await handle.db.execute(sql`DELETE FROM db_environment`);
  for (const r of rows) await handle.db.execute(sql`INSERT INTO db_environment (environment) VALUES (${r})`);
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  delete process.env.IS_PULL_REQUEST;
  setRuntime("1", HOST);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { consoleLines.push(a.map(String).join(" ")); });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    if (url.startsWith("https://api.pwnedpasswords.com/range/")) return new Response("0000000000000000000000000000000000A:0\n", { status: 200 });
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
  resetFreshShopThrottle();
  await mark(["staging"]);
});

describe("the staging walkthrough, signup to desk to sign out and back in", () => {
  it("runs on the real routes with the code on screen, no card, one test-shop desk and the existing staging sign-in", async () => {
    const jar: Jar = {};
    const door = await call(jar, "POST", "/api/staging/fresh-onboarding");
    expect(door.statusCode).toBe(201);
    const { start, email } = door.json() as { start: string; email: string };
    const ticket = new URL(start, "https://x").searchParams.get("door")!;
    const applied = await call(jar, "POST", "/api/enquiries", {
      kind: "early_access", form: "early-access-v2.1", email: "typed@example.com", name: "Staging Owner", stagingDoor: ticket,
      details: { firstName: "Staging", lastName: "Owner", shopName: "Harbour Test", workspace: "harbour-test.currencydeskos.com", website: "none yet", mode: "early_access",
        jurisdiction: "CA", province: "ON", country: "Canada", state: null, fintracRegistered: "Yes", msbNumber: null, waitlist: false, waitlistReason: null, role: "Owner",
        employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single", runningOn: "Spreadsheets", timeline: "This quarter", phone: "+1 4165550148", bestTime: "no call", samConsent: null },
      contactContext: { timezone: "America/Toronto" },
    });
    expect(applied.statusCode, applied.body).toBe(201);
    const cdId = applied.json().cdId as string;
    const base = `/api/onboarding/${cdId}`;
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.cdId, cdId)))[0]!;
    expect(row.email).toBe(email);
    expect(stagingFixtureRow(row)).toBe(true);

    /* the credential: the ordinary code, in this response only */
    const first = await signedUpTo(jar, base);
    /* resend replaces it: the first no longer works, the new one does */
    const again = await call(jar, "POST", `${base}/email/send`, {});
    expect(again.statusCode).toBe(200);
    const second = again.json().stagingCode as string;
    expect(second).toMatch(/^\d{6}$/);
    const account = await loadAccount(handle.db, row.id);
    expect(account.codeAttempts).toBe(0);
    expect(account.codeSends).toHaveLength(2);
    if (first !== second) expect((await call(jar, "POST", `${base}/email/verify`, { code: first })).statusCode).toBe(401);
    expect((await call(jar, "POST", `${base}/email/verify`, { code: second })).statusCode).toBe(200);
    expect((await call(jar, "POST", `${base}/pin`, { pin: "4821", confirm: "4821" })).statusCode).toBe(200);
    for (const [step, answers] of STEPS) expect((await call(jar, "PUT", `${base}/answers`, { step, answers })).statusCode).toBe(200);
    expect((await call(jar, "POST", `${base}/confirm`, { signed: true, name: "Staging Owner" })).statusCode).toBe(200);

    /* the plan: prepared without a card processor; nothing open yet */
    const pay = await call(jar, "POST", `${base}/payment`, PLAN);
    expect(pay.statusCode, pay.body).toBe(200);
    expect(pay.json()).toMatchObject({ ok: true, staging: true, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH, price: { currency: "CAD", dueTodayMinor: 0 } });
    expect(pay.json().clientSecret).toBeUndefined();
    expect((await call(jar, "POST", `${base}/open`)).statusCode).toBe(202);

    /* Open: assent and activation, then the real session */
    const opened = await call(jar, "POST", `${base}/staging-open`, AGREE);
    expect(opened.statusCode, opened.body).toBe(200);
    const retry = await call(jar, "POST", `${base}/staging-open`, AGREE);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe("already_open");
    const inside = await call(jar, "POST", `${base}/open`);
    expect(inside.statusCode, inside.body).toBe(200);
    const tenantId = inside.json().tenantId as string;
    expect(jar.cdos_session).toBeTruthy();
    expect((await call(jar, "POST", `${base}/open`)).statusCode).toBe(401);

    const tenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0]!;
    expect(tenant.isTestShop).toBe(true);
    expect(tenant.siteSlug).toBe(row.details?.slug);
    expect(await handle.db.select().from(schema.tenants).where(eq(schema.tenants.siteSlug, String(row.details?.slug)))).toHaveLength(1);
    expect(await handle.db.select().from(schema.stripeCustomers).where(eq(schema.stripeCustomers.tenantId, tenantId))).toHaveLength(0);
    const after = await loadAccount(handle.db, row.id);
    expect(after.state).toBe("active");
    expect(after.stripeCustomerId).toBeNull();
    expect(after.setupIntentId).toBeNull();
    const plans = await handle.db.select().from(schema.signupAgreements).where(and(eq(schema.signupAgreements.enquiryId, row.id), eq(schema.signupAgreements.kind, "plan")));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.record).toMatchObject({ agreed: true, staging: true, setupIntentId: null, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH });
    expect(await handle.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, tenantId), eq(schema.auditEvents.action, "signup.completed")))).toHaveLength(1);
    const owner = (await handle.db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, email))))[0]!;
    expect(owner.cdId).toBe(cdId);
    expect(owner.mustChangePassword).toBe(false);

    /* the real Home is the new tenant's */
    const home = await call(jar, "GET", "/api/tenant");
    expect(home.statusCode, home.body).toBe(200);
    expect(home.body).toContain(tenantId);

    /* sign out, then the existing staging sign-in for a test owner */
    expect((await call(jar, "POST", "/api/auth/logout", {})).statusCode).toBeLessThan(300);
    expect((await call(jar, "GET", "/api/tenant")).statusCode).toBe(401);
    // Direct auth callsite regressions: every failed provenance gate must
    // withhold the code, even with the right password and a test-shop flag.
    const returningStart = (headers: Record<string, string> = { host: HOST }) => call(jar, "POST", "/api/auth/login/start", { staffId: cdId, password: PASSWORD }, headers);
    const noDisclosure = async (headers?: Record<string, string>, status = 200) => {
      forgetCooldown("login:" + owner.id);
      const response = await returningStart(headers);
      expect(response.statusCode).toBe(status);
      expect(response.json()).not.toHaveProperty("code");
      expect(response.cookies.some(c => c.name === "cdos_session")).toBe(false);
    };
    const delivery = vi.spyOn(emailTransport, "sendEmail").mockResolvedValue("sent");
    await mark([]); await noDisclosure(); await mark(["staging"]);
    await noDisclosure({ host: "www.currencydeskos.com", "x-forwarded-host": HOST });
    await handle.db.update(schema.tenants).set({ siteSlug: "wrong-slug" }).where(eq(schema.tenants.id, tenantId));
    await noDisclosure();
    await handle.db.update(schema.tenants).set({ siteSlug: String(row.details?.slug), isTestShop: false }).where(eq(schema.tenants.id, tenantId));
    await noDisclosure();
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, tenantId));
    for (const change of [{ status: "invited" as const }, { tenantId: "tnt-yorkfx" }, { doNotContactReason: "operator" }, { details: { ...row.details, stagingFresh: false } }]) {
      await handle.db.update(schema.enquiries).set(change).where(eq(schema.enquiries.id, row.id));
      await noDisclosure(undefined, "tenantId" in change ? 401 : 200); // existing activation guard rejects the wrong tenant
      await handle.db.update(schema.enquiries).set({ status: "accepted", tenantId, doNotContactReason: row.doNotContactReason, details: row.details }).where(eq(schema.enquiries.id, row.id));
    }
    delivery.mockRestore();
    forgetCooldown("login:" + owner.id);
    const startLogin = await returningStart(); // canonical CD-ID; helper must receive resolved email

    expect(startLogin.statusCode, startLogin.body).toBe(200);
    const oldProof = { ...jar };
    forgetCooldown("login:" + owner.id); // test-only clock boundary, real replacement
    const replacement = await returningStart();
    expect(replacement.statusCode).toBe(200);
    expect((await call(oldProof, "POST", "/api/auth/login/verify", { staffId: cdId, code: startLogin.json().code })).statusCode).toBe(401);
    const loginCode = replacement.json().code as string;
    expect(loginCode).toMatch(/^\d{6}$/);
    expect((await call(jar, "POST", "/api/auth/login/verify", { staffId: email, code: loginCode })).statusCode).toBe(200);
    expect((await call(jar, "GET", "/api/tenant")).statusCode).toBe(200);

    /* nothing was mailed, logged or sent to a provider */
    const said = [...logs, ...consoleLines].join("\n");
    for (const code of [first, second, loginCode]) expect(said).not.toContain(code);
    expect(said).not.toContain("[email");
    expect(fetched.filter((u) => !u.startsWith("https://api.pwnedpasswords.com/"))).toEqual([]);
  });
});

/* password save only, returning the code it handed back */
async function signedUpTo(jar: Jar, base: string) {
  const saved = await call(jar, "POST", `${base}/password`, { password: PASSWORD, confirm: PASSWORD });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json()).toMatchObject({ ok: true, kind: "password", codeSent: true });
  expect(saved.json().stagingCode).toMatch(/^\d{6}$/);
  return saved.json().stagingCode as string;
}

describe("every gate closes the helper on its own", () => {
  const noCode = async (r: { base: string; email: string }, headers?: Record<string, string>) => {
    const jar: Jar = {};
    const said = consoleLines.length;
    const saved = await call(jar, "POST", `${r.base}/password`, { password: PASSWORD, confirm: PASSWORD }, headers);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().stagingCode).toBeUndefined();
    const resend = await call(jar, "POST", `${r.base}/email/send`, {}, headers);
    expect(resend.json().stagingCode).toBeUndefined();
    /* a staging.invalid address is never handed to the mailer, open gate or not */
    if (r.email.endsWith("@staging.invalid")) expect(consoleLines.slice(said).join("\n")).not.toContain("[email");
    return { jar, saved };
  };

  it("a live Host, a spoofed forwarded host, or no Host", async () => {
    const r = await reservation("fixture");
    await noCode(r, { host: "www.currencydeskos.com", "x-forwarded-host": HOST });
    await noCode(await reservation("fixture"), { host: "currencydesk.onrender.com", "x-forwarded-host": HOST });
  });

  it("a live runtime: STAGING unset, or a live service hostname", async () => {
    setRuntime(undefined, HOST);
    await noCode(await reservation("fixture"));
    setRuntime("1", "www.currencydeskos.com");
    await noCode(await reservation("fixture"));
  });

  it("an unmarked database: no row, a live row, or two rows", async () => {
    for (const rows of [[], ["production"], ["staging", "staging"]]) {
      await mark(rows);
      expect(await databaseMarkedStaging(handle.db)).toBe(false);
      await noCode(await reservation("fixture"));
    }
  });

  it("an ordinary reservation, or one whose markers disagree", async () => {
    await noCode(await reservation("ordinary"));
    await noCode(await reservation("fixture", (row) => { (row.details as Record<string, unknown>).slug = "stg-00000000"; }));
    await noCode(await reservation("fixture", (row) => { row.doNotContactReason = "operator"; }));
    await noCode(await reservation("fixture", (row) => { delete (row.details as Record<string, unknown>).stagingFresh; }));
    await noCode(await reservation("fixture", (row) => { row.email = String(row.email).replace("owner+", "owner+0"); }));
  });

  it("an ordinary reservation's plan still needs Stripe, and staging-open is 404 for it", async () => {
    const r = await reservation("ordinary");
    const jar: Jar = {};
    expect((await call(jar, "POST", `${r.base}/password`, { password: PASSWORD, confirm: PASSWORD })).statusCode).toBe(200);
    expect((await call(jar, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(401);
    /* its code went to its inbox (hash only); stand in for reading it */
    await handle.db.update(schema.signupAccounts).set({ codeHash: hashCode("135790"), codeExpiresAt: new Date(Date.now() + 60_000), codeAttempts: 0 }).where(eq(schema.signupAccounts.enquiryId, r.id));
    expect((await call(jar, "POST", `${r.base}/email/verify`, { code: "135790" })).statusCode).toBe(200);
    expect((await call(jar, "POST", `${r.base}/pin`, { pin: "4821", confirm: "4821" })).statusCode).toBe(200);
    for (const [step, answers] of STEPS) expect((await call(jar, "PUT", `${r.base}/answers`, { step, answers })).statusCode).toBe(200);
    expect((await call(jar, "POST", `${r.base}/confirm`, { signed: true, name: "Staging Owner" })).statusCode).toBe(200);
    const pay = await call(jar, "POST", `${r.base}/payment`, PLAN);
    expect(pay.statusCode).toBe(503);
    expect(pay.json()).toMatchObject({ error: "payment_unavailable" });
    expect(pay.json().staging).toBeUndefined();
    expect((await call(jar, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(404);
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");
  });

  it("an unbound browser gets no code, and Open needs the enrolment session", async () => {
    const r = await reservation("fixture");
    const owner: Jar = {};
    await signedUpTo(owner, r.base);
    const stranger: Jar = {};
    const resend = await call(stranger, "POST", `${r.base}/email/send`, {});
    expect(resend.statusCode).toBe(409);
    expect(resend.json().stagingCode).toBeUndefined();
    expect((await call(stranger, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(401);
    expect((await call(stranger, "POST", `${r.base}/payment`, PLAN)).statusCode).toBe(401);
  });

  it("a closed fixture gate never falls back to a configured card processor", async () => {
    const r = await reservation("fixture");
    const jar: Jar = {};
    await signed(jar, r.base);
    const config = vi.spyOn(billing, "stripeBillingConfig").mockReturnValue({
      secretKey: "unused-test-key", prices: {
        basic: { monthly: undefined, annual: undefined },
        pro: { monthly: undefined, annual: undefined },
        premium: { monthly: undefined, annual: undefined },
      },
    });
    const factory = vi.spyOn(billing, "signupStripeClient").mockImplementation(() => { throw new Error("Synthetic shop reached Stripe"); });
    try {
      await mark([]);
      for (const path of ["payment", "plan"]) {
        const res = await call(jar, "POST", `${r.base}/${path}`, path === "plan" ? { ...PLAN, agreed: true } : PLAN);
        expect(res.statusCode, res.body).toBe(503);
        expect(res.json().error).toBe("staging_unavailable");
      }
      expect(factory).not.toHaveBeenCalled();
      const account = await loadAccount(handle.db, r.id);
      expect(account.state).toBe("verified");
      expect(account.stripeCustomerId).toBeNull();
      expect(account.setupIntentId).toBeNull();
    } finally {
      factory.mockRestore(); config.mockRestore();
    }
  });

  it("a stale signature, an invalid plan, or a gate that closes before Open creates nothing", async () => {
    const r = await reservation("fixture");
    const jar: Jar = {};
    await signed(jar, r.base);
    expect((await call(jar, "POST", `${r.base}/payment`, { ...PLAN, extras: { ...PLAN.extras, website: true } })).statusCode).toBe(409);
    expect((await call(jar, "POST", `${r.base}/payment`, { ...PLAN, plan: "free" })).statusCode).toBe(400);
    expect((await call(jar, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(409); // nothing prepared
    expect((await call(jar, "POST", `${r.base}/payment`, PLAN)).statusCode).toBe(200);
    expect((await call(jar, "POST", `${r.base}/staging-open`, { ...AGREE, termsSourceHash: "0".repeat(64) })).statusCode).toBe(400);
    /* an answer after signing clears the signature and the plan */
    expect((await call(jar, "PUT", `${r.base}/answers`, { step: "19-idline", answers: { idOver: "900" } })).statusCode).toBe(200);
    expect((await call(jar, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(409);
    expect((await call(jar, "POST", `${r.base}/confirm`, { signed: true, name: "Staging Owner" })).statusCode).toBe(200);
    expect((await call(jar, "POST", `${r.base}/payment`, PLAN)).statusCode).toBe(200);
    await mark([]);
    expect((await call(jar, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(404);
    const account = await loadAccount(handle.db, r.id);
    expect(account.state).toBe("verified");
    expect((await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, r.id)))[0]!.tenantId).toBeNull();
    expect(await handle.db.select().from(schema.signupAgreements).where(and(eq(schema.signupAgreements.enquiryId, r.id), eq(schema.signupAgreements.kind, "plan")))).toHaveLength(0);
  });

  it("Open pressed twice at once makes one desk and one assent", async () => {
    const r = await reservation("fixture");
    const jar: Jar = {};
    await signed(jar, r.base);
    expect((await call(jar, "POST", `${r.base}/payment`, PLAN)).statusCode).toBe(200);
    const both = await Promise.all([call({ ...jar }, "POST", `${r.base}/staging-open`, AGREE), call({ ...jar }, "POST", `${r.base}/staging-open`, AGREE)]);
    /* the second waits on the account lock and then answers already open */
    for (const x of both) expect([200, 409], x.body).toContain(x.statusCode);
    expect(both.some((x) => x.statusCode === 200)).toBe(true);
    const ob = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, r.id)))[0]!;
    expect(ob.tenantId).toBeTruthy();
    expect(await handle.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, ob.tenantId!), eq(schema.auditEvents.action, "signup.completed")))).toHaveLength(1);
    expect(await handle.db.select().from(schema.signupAgreements).where(and(eq(schema.signupAgreements.enquiryId, r.id), eq(schema.signupAgreements.kind, "plan")))).toHaveLength(1);
  });
});

describe("the no-card Open follows the same decision as a card", () => {
  it("a synthetic shop held or declined after its plan opens nothing and records no assent", async () => {
    for (const to of ["hold", "declined"] as const) {
      const r = await reservation("fixture");
      const jar: Jar = {};
      await signed(jar, r.base);
      expect((await call(jar, "POST", `${r.base}/payment`, PLAN)).statusCode).toBe(200);
      const before = await loadAccount(handle.db, r.id);
      const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, r.id)))[0]!;
      expect((await moveTo(handle.db, row, to, "support", { quiet: true })).ok).toBe(true);
      /* the route's guard answers first; the activation refuses on its own too */
      expect((await call(jar, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(404);
      expect(await openStagingDesk(handle.db, r.id)).toEqual({ opened: false, reason: "not_invited" });
      expect(await loadAccount(handle.db, r.id)).toEqual(before);
      expect((await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, r.id)))[0]).toMatchObject({ status: to, tenantId: null });
      expect((await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, r.id)))[0]!.tenantId).toBeNull();
      expect(await handle.db.select().from(schema.signupAgreements).where(and(eq(schema.signupAgreements.enquiryId, r.id), eq(schema.signupAgreements.kind, "plan")))).toHaveLength(0);
    }
  });
});

describe("stagingFixtureOwner, for the returning sign-in (CD221)", () => {
  it("names only the owner the synthetic shop activated, on every gate", async () => {
    const r = await reservation("fixture");
    const jar: Jar = {};
    await signed(jar, r.base);
    expect((await call(jar, "POST", `${r.base}/payment`, PLAN)).statusCode).toBe(200);
    expect((await call(jar, "POST", `${r.base}/staging-open`, AGREE)).statusCode).toBe(200);
    const tenantId = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, r.id)))[0]!.tenantId!;
    const host = { host: HOST };
    expect(await stagingFixtureOwner(handle.db, host, r.email, tenantId)).toBe(true);
    expect(await stagingFixtureOwner(handle.db, host, r.email.toUpperCase(), tenantId)).toBe(true);
    /* host and runtime */
    expect(await stagingFixtureOwner(handle.db, { host: "www.currencydeskos.com", "x-forwarded-host": HOST }, r.email, tenantId)).toBe(false);
    expect(await stagingFixtureOwner(handle.db, {}, r.email, tenantId)).toBe(false);
    setRuntime(undefined, HOST);
    expect(await stagingFixtureOwner(handle.db, host, r.email, tenantId)).toBe(false);
    setRuntime("1", HOST);
    /* identity and tenant correlation */
    expect(await stagingFixtureOwner(handle.db, host, "owner+00000000@staging.invalid", tenantId)).toBe(false);
    expect(await stagingFixtureOwner(handle.db, host, r.email, "tnt-yorkfx")).toBe(false);
    const other = await reservation("ordinary");
    expect(await stagingFixtureOwner(handle.db, host, other.email, tenantId)).toBe(false);
    /* the slug the tenant carries must be the reservation's */
    await handle.db.update(schema.tenants).set({ siteSlug: `moved-${seq}` }).where(eq(schema.tenants.id, tenantId));
    expect(await stagingFixtureOwner(handle.db, host, r.email, tenantId)).toBe(false);
    const enquiry = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, r.id)))[0]!;
    await handle.db.update(schema.tenants).set({ siteSlug: String(enquiry.details?.slug) }).where(eq(schema.tenants.id, tenantId));
    expect(await stagingFixtureOwner(handle.db, host, r.email, tenantId)).toBe(true);
    /* a test-shop flag cleared, or the database unmarked */
    await handle.db.update(schema.tenants).set({ isTestShop: false }).where(eq(schema.tenants.id, tenantId));
    expect(await stagingFixtureOwner(handle.db, host, r.email, tenantId)).toBe(false);
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, tenantId));
    await mark([]);
    expect(await stagingFixtureOwner(handle.db, host, r.email, tenantId)).toBe(false);
  });
});
