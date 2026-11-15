/* Sign-up v2.1, the page's side of the server (build doc §2, §6, §10):
   which page a visitor gets, the price list the plan screen renders, the
   test-only seed, the "You're in" link, and the browser suite's mailbox. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { registerSignupDeskRoutes } from "../src/routes/signup-desk.js";
import { loadAccount, sha256 } from "../src/onboarding/signup-account.js";
import { priceList } from "../src/onboarding/signup-open.js";
import { seedAllowed } from "../src/routes/signup-page.js";
import { sendEmail } from "../src/email.js";
import { testMailbox } from "../src/email-test-mailbox.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const asDocument = { "sec-fetch-dest": "document", accept: "text/html" };

describe("the price list (money: integers, the server's arithmetic)", () => {
  it("quotes every plan per location in CAD minor units; annual is 10% off and keeps cents", () => {
    const one = priceList(1);
    expect(one.currency).toBe("CAD");
    expect(one.plans.ai.monthly).toMatchObject({ perLocationMinor: 75_000, totalMinor: 75_000, yearMinor: 900_000, dueTodayMinor: 0, aboutPerDayMinor: 2_500 });
    expect(one.plans.full.annual).toMatchObject({ perLocationMinor: 53_910, perLocationYearMinor: 646_920, annualSavingMinor: 71_880 });
    expect(one.plans.ai.annual.annualSavingMinor).toBe(90_000);
    expect(one.setupWeekMinor).toBe(500_000);
    for (const plan of Object.values(one.plans)) for (const q of Object.values(plan)) for (const v of Object.values(q)) expect(Number.isInteger(v)).toBe(true);
  });
  it("multiplies by locations and clamps nonsense", () => {
    expect(priceList(3).plans.full.annual.totalMinor).toBe(161_730);
    expect(priceList(0).locations).toBe(1);
    expect(priceList(99).locations).toBe(50);
  });
});

describe("the test seed is never available on a real server", () => {
  it("needs SIGNUP_TEST_SEED=1, and never in production or on staging", () => {
    expect(seedAllowed({})).toBe(false);
    expect(seedAllowed({ SIGNUP_TEST_SEED: "1", NODE_ENV: "development" })).toBe(true);
    expect(seedAllowed({ SIGNUP_TEST_SEED: "1", NODE_ENV: "production" })).toBe(false);
    expect(seedAllowed({ SIGNUP_TEST_SEED: "1", NODE_ENV: "development", STAGING: "1" })).toBe(false);
  });
});


describe("the browser suite's mailbox", () => {
  it("is closed on every real server: a sign-up code is refused, not kept, not logged", async () => {
    expect(testMailbox()).toBeNull();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
    delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
    expect(await sendEmail("o@x.test", "Your code", { text: "123456", sensitive: true })).toBe("failed");
    expect(log.mock.calls.flat().join(" ")).not.toContain("123456");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("123456");
    process.env.RESEND_API_KEY = saved.key; process.env.EMAIL_FROM = saved.from;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    if (saved.from === undefined) delete process.env.EMAIL_FROM;
    log.mockRestore(); warn.mockRestore();
  });
});

describe("prices on the enrolment session", () => {
  let handle: DbHandle; let app: FastifyInstance; let door: ReturnType<typeof createIdDoor>;
  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    handle = await createDb();
    app = Fastify(); await app.register(cookie);
    door = createIdDoor({ db: handle.db, logRefusal: () => {} });
    registerSignupDeskRoutes(app, handle.db, door, { stripe: () => null });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await handle.close(); });
  beforeEach(() => door.reset());

  it("public list price for one location; this desk's quote needs its session and uses its own shop count", async () => {
    const pub = await app.inject({ method: "GET", url: "/api/onboarding/prices" });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().locations).toBe(1);

    const id = `enq-${randomUUID()}`, cdId = "CD-PRIC-7K42";
    await handle.db.insert(schema.enquiries).values({ id, reference: "CD-P00001", kind: "early_access", email: "p@yorkfx.test", status: "invited", cdId, details: { shopName: "Harbour", jurisdiction: "CA" } });
    await loadAccount(handle.db, id);
    await handle.db.update(schema.signupAccounts).set({ state: "verified" }).where(eq(schema.signupAccounts.enquiryId, id));
    expect((await app.inject({ method: "GET", url: `/api/onboarding/${cdId}/prices` })).statusCode).toBe(401);

    const token = randomBytes(32).toString("base64url");
    await handle.db.insert(schema.enrolmentSessions).values({ tokenHash: sha256(token), enquiryId: id, expiresAt: new Date(Date.now() + 60_000) });
    await handle.db.insert(schema.onboarding).values({ enquiryId: id, answers: { shops: "more", shopCount: 3 } }).onConflictDoNothing();
    await handle.db.update(schema.onboarding).set({ answers: { shops: "more", shopCount: 3 } }).where(eq(schema.onboarding.enquiryId, id));
    const mine = await app.inject({ method: "GET", url: `/api/onboarding/${cdId}/prices?locations=99`, cookies: { cd_enrol: token } });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().locations).toBe(3);
    expect(mine.json().plans.full.annual.totalMinor).toBe(161_730);
  });

  it("resume says whether last_step was finished or is only where to start", async () => {
    const id = `enq-${randomUUID()}`, cdId = "CD-RESM-7K42";
    await handle.db.insert(schema.enquiries).values({ id, reference: "CD-P00002", kind: "early_access", email: "r@yorkfx.test", status: "invited", cdId, details: { shopName: "Harbour", jurisdiction: "CA" } });
    await loadAccount(handle.db, id);
    await handle.db.update(schema.signupAccounts).set({ state: "verified" }).where(eq(schema.signupAccounts.enquiryId, id));
    const token = randomBytes(32).toString("base64url");
    await handle.db.insert(schema.enrolmentSessions).values({ tokenHash: sha256(token), enquiryId: id, expiresAt: new Date(Date.now() + 60_000) });
    const fresh = (await app.inject({ method: "GET", url: `/api/onboarding/${cdId}/resume`, cookies: { cd_enrol: token } })).json();
    expect(fresh).toMatchObject({ lastStep: "06-pin-intro", saved: false });
    await app.inject({ method: "PUT", url: `/api/onboarding/${cdId}/answers`, payload: { step: "08-shop-name", answers: { operatingName: "Harbour" } }, cookies: { cd_enrol: token } });
    const later = (await app.inject({ method: "GET", url: `/api/onboarding/${cdId}/resume`, cookies: { cd_enrol: token } })).json();
    expect(later).toMatchObject({ lastStep: "08-shop-name", saved: true });
  });
});

