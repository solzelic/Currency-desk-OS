import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { loadAccount, saveCredential } from "../src/onboarding/signup-account.js";
import { sendSignupCode, verifySignupCode } from "../src/onboarding/email-code.js";
import { confirmDesk, startPayment, openFromSetupIntent, type SignupStripe } from "../src/onboarding/signup-open.js";
import { hashCode } from "../src/email.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("signup proof under real PostgreSQL concurrency", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    try { handle = await createDb(); }
    finally { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; }
  });
  afterAll(async () => { await handle?.close(); });
  async function candidate() {
    const id = `proof-${randomUUID()}`;
    const row = (await handle.db.insert(schema.enquiries).values({ id, reference: id, kind: "early_access", status: "invited", email: `${id}@example.test`, name: "Synthetic", details: {} }).returning())[0]!;
    await loadAccount(handle.db, id);
    await saveCredential(handle.db, id, { kind: "password", attemptHash: "browser", passwordHash: "first" });
    await handle.db.update(schema.signupAccounts).set({ codeHash: hashCode("123456"), codeExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.signupAccounts.enquiryId, id));
    return row;
  }
  it("replacing a choice in one browser verifies only its latest credential", async () => {
    const row = await candidate();
    await saveCredential(handle.db, row.id, { kind: "password", attemptHash: "browser", passwordHash: "replacement" });
    expect((await verifySignupCode(handle.db, row.id, "browser", "123456")).ok).toBe(true);
    const credentials = await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, row.id));
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.passwordHash).toBe("replacement");
  });
  it("a delayed credential save cannot mutate an already verified account", async () => {
    const row = await candidate();
    expect((await verifySignupCode(handle.db, row.id, "browser", "123456")).ok).toBe(true);
    const saved = await saveCredential(handle.db, row.id, { kind: "password", attemptHash: "late-attacker", passwordHash: "late" });
    expect(saved).toBeNull();
    expect(await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, row.id))).toHaveLength(1);
  });
  it("parallel incorrect codes cannot lose attempts", async () => {
    const row = await candidate();
    await Promise.all(Array.from({ length: 12 }, () => verifySignupCode(handle.db, row.id, "browser", "999999")));
    expect((await loadAccount(handle.db, row.id)).codeAttempts).toBe(5);
    expect((await verifySignupCode(handle.db, row.id, "browser", "123456")).ok).toBe(false);
  });
  it("parallel sends cannot exceed three messages in the window", async () => {
    const row = await candidate();
    let delivered = 0;
    await Promise.all(Array.from({ length: 10 }, () => sendSignupCode(handle.db, row, "Synthetic", async () => { delivered++; return "sent"; })));
    expect(delivered).toBe(3);
    expect((await loadAccount(handle.db, row.id)).codeSends).toHaveLength(3);
  });
  it("parallel valid codes create exactly one session", async () => {
    const row = await candidate();
    const results = await Promise.all(Array.from({ length: 8 }, () => verifySignupCode(handle.db, row.id, "browser", "123456")));
    expect(results.filter(x => x.ok)).toHaveLength(1);
    expect(await handle.db.select().from(schema.enrolmentSessions).where(eq(schema.enrolmentSessions.enquiryId, row.id))).toHaveLength(1);
  });
  async function paymentReady() {
    const row = await candidate();
    await verifySignupCode(handle.db, row.id, "browser", "123456");
    await handle.db.update(schema.signupAccounts).set({ pinHash: "synthetic-never-used" }).where(eq(schema.signupAccounts.enquiryId, row.id));
    await handle.db.update(schema.enquiries).set({ details: { jurisdiction: "CA" } }).where(eq(schema.enquiries.id, row.id));
    await handle.db.insert(schema.onboarding).values({ enquiryId: row.id, answers: { operatingName: row.id, bizName: "Synthetic Incorporated", street: "1 Test", city: "Toronto", region: "ON", postal: "M1A 1A1", currencies: ["CAD", "USD"], idOver: "0", team: [{ first: "Synthetic", last: "Colleague", role: "Manager", email: `${row.id}-staff@example.test` }] } });
    expect(await confirmDesk(handle.db, row.id, "Synthetic Owner")).toBe(true);
    let metadata: Record<string, string> = {};
    const customer = `cus_${randomUUID()}`;
    const id = `seti_${randomUUID()}`;
    const stripe: SignupStripe = { customers: { create: async () => ({ id: customer }) }, setupIntents: { create: async (p) => { metadata = p.metadata; return { id, client_secret: "test_only" }; } } };
    await startPayment(handle.db, stripe, { ...row, details: { jurisdiction: "CA" } }, { plan: "full", term: "annual", locations: 1, brief: false, call: false, website: false, setupWeek: false });
    return { row, intent: { id, customer, status: "succeeded", paymentMethod: "pm_test", metadata } };
  }
  it("parallel activation opens once and preserves team names and the every-deal ID policy", async () => {
    const { row, intent } = await paymentReady();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => openFromSetupIntent(handle.db, intent)));
    expect(outcomes.filter(x => x.opened)).toHaveLength(1);
    const ob = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, row.id)))[0]!;
    expect((await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, ob.tenantId!)))[0]?.idThreshold).toBe("0.00");
    expect((await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, `${row.id}-staff@example.test`)))[0]?.name).toBe("Synthetic Colleague");
    expect((await loadAccount(handle.db, row.id)).state).toBe("active");
  });
  it("an activation audit failure rolls back tenant creation and leaves payment retryable", async () => {
    const { row, intent } = await paymentReady();
    await handle.db.execute(sql`CREATE OR REPLACE FUNCTION cd206_fail_signup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'signup.completed' THEN RAISE EXCEPTION 'synthetic activation failure'; END IF; RETURN NEW; END $$`);
    await handle.db.execute(sql`CREATE TRIGGER cd206_fail_signup_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION cd206_fail_signup_audit()`);
    try {
      await expect(openFromSetupIntent(handle.db, intent)).rejects.toThrow();
      expect((await loadAccount(handle.db, row.id)).state).toBe("verified");
      expect((await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, row.id)))[0]?.tenantId).toBeNull();
      expect(await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, row.email))).toHaveLength(0);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER cd206_fail_signup_audit ON audit_events`);
      await handle.db.execute(sql`DROP FUNCTION cd206_fail_signup_audit()`);
    }
    expect((await openFromSetupIntent(handle.db, intent)).opened).toBe(true);
  });

});
