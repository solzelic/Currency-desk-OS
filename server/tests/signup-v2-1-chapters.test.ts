/* Sign-up v2.1, PR 5: chapters 2 to 4 save per screen and resume at
   last_step, with every country-shaped thing from the pack
   (SIGNUP-LOGIC §4; build doc §3, §7, §10 "resume at last_step"). */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { registerSignupDeskRoutes } from "../src/routes/signup-desk.js";
import { loadAccount, sha256 } from "../src/onboarding/signup-account.js";
import { parseAnswers } from "../src/onboarding/signup-answers.js";
import { signupPack } from "../src/onboarding/signup-pack.js";

let handle: DbHandle;
let app: FastifyInstance;
let door: ReturnType<typeof createIdDoor>;
let n = 0;

async function enrolled(over: Record<string, unknown> = {}) {
  n++;
  const id = `enq-${randomUUID()}`;
  const A = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const cdId = `CD-CHAP-${A[n % 31]}${A[(n * 3) % 31]}${A[(n * 5) % 31]}${A[(n * 7) % 31]}`;
  await handle.db.insert(schema.enquiries).values({
    id, reference: `CD-H${String(n).padStart(5, "0")}`, kind: "early_access", email: `chap${n}@yorkfx.test`, status: "invited", cdId,
    details: { shopName: "Harbour Exchange", msbNumber: "M12345678", jurisdiction: "CA", workspace: "harbour.currencydeskos.com", ...over },
  });
  await loadAccount(handle.db, id);
  await handle.db.update(schema.signupAccounts).set({ state: "verified" }).where(eq(schema.signupAccounts.enquiryId, id));
  const token = randomBytes(32).toString("base64url");
  await handle.db.insert(schema.enrolmentSessions).values({ tokenHash: sha256(token), enquiryId: id, expiresAt: new Date(Date.now() + 60_000) });
  return { id, cdId, session: { cd_enrol: token } };
}
const put = (cdId: string, body: unknown, cookies: Record<string, string>) =>
  app.inject({ method: "PUT", url: `/api/onboarding/${cdId}/answers`, payload: body as object, cookies });
const resume = (cdId: string, cookies: Record<string, string>) =>
  app.inject({ method: "GET", url: `/api/onboarding/${cdId}/resume`, cookies });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  handle = await createDb();
  app = Fastify();
  await app.register(cookie);
  door = createIdDoor({ db: handle.db, logRefusal: () => {} });
  registerSignupDeskRoutes(app, handle.db, door);
  await app.ready();
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => door.reset());

describe("saving on Continue", () => {
  it("keeps only the screen's own fields, under the design's names, and moves last_step", async () => {
    const r = await enrolled();
    const res = await put(r.cdId, { step: "08-shop-name", answers: { operatingName: "Harbour FX", bizName: "Harbour Exchange Inc.", ownerPass: "hunter2hunter2", idOver: "1" } }, r.session);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, lastStep: "08-shop-name" });
    const row = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, r.id)))[0]!;
    expect(row.answers).toEqual({ operatingName: "Harbour FX", bizName: "Harbour Exchange Inc." });
    expect((await loadAccount(handle.db, r.id)).lastStep).toBe("08-shop-name");
  });

  it("refuses a malformed answer (422) and an unknown step (400)", async () => {
    const r = await enrolled();
    expect((await put(r.cdId, { step: "19-idline", answers: { idOver: "1,000" } }, r.session)).statusCode).toBe(422);
    expect((await put(r.cdId, { step: "24-pay-plan", answers: {} }, r.session)).statusCode).toBe(400);
    expect((await put(r.cdId, { step: "11-shops-more", answers: { shopCount: 1 } }, r.session)).statusCode).toBe(422);
  });

  it("takes team members with or without email, six roles only, and vault counts as decimal strings", () => {
    expect(parseAnswers("20-team", { team: [{ first: "Samira", last: "Haddad", role: "Manager", email: "s@x.test" }, { first: "Diego", last: "Alvarez", role: "Cashier", email: "" }] }).ok).toBe(true);
    expect(parseAnswers("20-team", { team: [{ first: "A", last: "B", role: "Owner" }] }).ok).toBe(false);
    expect(parseAnswers("15-count", { count: { USD: { mode: "notes", notes: { "100": 3, "20": 4 }, coins: "1.25" } } }).ok).toBe(true);
    expect(parseAnswers("15-count", { count: { USD: { mode: "total", total: 12.5 } } }).ok).toBe(false);
    expect(parseAnswers("14-currencies", { currencies: ["USD", "eur"] }).ok).toBe(false);
  });

  it("needs the enrolment session and a verified account", async () => {
    const r = await enrolled();
    expect((await put(r.cdId, { step: "08-shop-name", answers: {} }, {})).statusCode).toBe(401);
    await handle.db.update(schema.signupAccounts).set({ state: "enrolling" }).where(eq(schema.signupAccounts.enquiryId, r.id));
    expect((await put(r.cdId, { step: "08-shop-name", answers: {} }, r.session)).statusCode).toBe(409);
  });
});

describe("coming back", () => {
  it("resumes at last_step with the answers, seeded from the application, and the pack", async () => {
    const r = await enrolled();
    await put(r.cdId, { step: "09-address", answers: { street: "1420 Dundas St W", city: "Toronto", region: "ON", postal: "M6J 1Y5" } }, r.session);
    await put(r.cdId, { step: "14-currencies", answers: { currencies: ["USD", "EUR"] } }, r.session);
    const res = await resume(r.cdId, r.session);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.lastStep).toBe("14-currencies");
    expect(body.answers).toMatchObject({ operatingName: "Harbour Exchange", msbNumber: "M12345678", street: "1420 Dundas St W", currencies: ["USD", "EUR"] });
    expect(body.pack).toMatchObject({ code: "CA", regulator: "FINTRAC", homeCurrency: "CAD", billingCurrency: "CAD", idLine: { legal: 3000, recommended: 1000, currency: "CAD" } });
    expect(body.pack.registration.label).toBe("FINTRAC registration number");
    expect(body.workspace).toBe("harbour");
  });

  it("never sends back a secret, even one an older page left on the row", async () => {
    const r = await enrolled();
    await handle.db.insert(schema.onboarding).values({ enquiryId: r.id, answers: { ownerPass: "old secret", code: "123456", cardNum: "4242", pin: "4821", street: "1 Bay St" } }).onConflictDoNothing();
    await handle.db.update(schema.onboarding).set({ answers: { ownerPass: "old secret", code: "123456", cardNum: "4242", pin: "4821", street: "1 Bay St" } }).where(eq(schema.onboarding.enquiryId, r.id));
    const body = (await resume(r.cdId, r.session)).json();
    expect(body.answers.street).toBe("1 Bay St");
    for (const k of ["ownerPass", "code", "cardNum", "pin"]) expect(body.answers).not.toHaveProperty(k);
  });

  it("starts at the PIN when no PIN is set", async () => {
    const r = await enrolled();
    expect((await resume(r.cdId, r.session)).json()).toMatchObject({ lastStep: "06-pin-intro", pinSet: false });
  });
});

describe("the pack", () => {
  it("hard-codes nothing Canadian outside Canada", () => {
    const uk = signupPack("GB");
    expect(uk).toMatchObject({ regulator: "HMRC", homeCurrency: "GBP", billingCurrency: null, idLine: { legal: null, recommended: null }, law: [] });
    expect(JSON.stringify(uk)).not.toMatch(/CAD|FINTRAC|province/i);
    expect(signupPack("ZZ").code).toBe("XX");
  });
});
