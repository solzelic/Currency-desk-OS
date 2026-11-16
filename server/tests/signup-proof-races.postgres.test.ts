import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueCdId, mintCdId } from "../src/enquiries/cd-id.js";
import { buildApp } from "../src/app.js";
import { backendRolePermissions } from "../src/auth/permissions.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { loadAccount, saveCredential } from "../src/onboarding/signup-account.js";
import { sendSignupCode, verifySignupCode } from "../src/onboarding/email-code.js";
import { confirmDesk, startPayment, openFromSetupIntent, type SignupStripe } from "../src/onboarding/signup-open.js";
import { savePin } from "../src/onboarding/signup-pin.js";
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
  it("competing reservations cannot commit the same freshly issued ID", async () => {
    // Both lookups deliberately finish before either insert: exercise the
    // database backstop, rather than relying on random collision odds.
    const ids = await Promise.all([issueCdId(handle.db, "Race", n => new Uint8Array(n)), issueCdId(handle.db, "Race", n => new Uint8Array(n))]);
    expect(ids[0]).toBe(ids[1]);
    const results = await Promise.allSettled(ids.map(cdId => {
      const id = randomUUID();
      return handle.db.insert(schema.enquiries).values({ id, reference: id, kind: "early_access", email: "synthetic@example.test", cdId }).returning();
    }));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.cdId, ids[0]!))).toHaveLength(1);
    await handle.db.delete(schema.enquiries).where(eq(schema.enquiries.cdId, ids[0]!));
  });
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
  async function paymentReady(staging = false) {
    const row = await candidate();
    const proof = await verifySignupCode(handle.db, row.id, "browser", "123456");
    if (!proof.ok) throw new Error("proof refused");
    const cdId = mintCdId("Harbour");
    await handle.db.update(schema.signupAccounts).set({ pinHash: "synthetic-never-used" }).where(eq(schema.signupAccounts.enquiryId, row.id));
    await handle.db.update(schema.enquiries).set({ cdId, name: "Daniel Okafor", ...(staging ? { email: `${row.id}@staging.invalid` } : {}), details: { jurisdiction: "CA", phone: "+14165550142", ...(staging ? { stagingFresh: true, slug: `stg-${row.id}` } : {}) } }).where(eq(schema.enquiries.id, row.id));
    await handle.db.insert(schema.onboarding).values({ enquiryId: row.id, answers: { operatingName: row.id, bizName: "Synthetic Incorporated", street: "1420 Dundas St W", unit: "204", complianceMode: "me", msbNumber: "M12345678", city: "Toronto", region: "ON", postal: "M1A 1A1", currencies: ["USD", "EUR"], idOver: "0", team: [{ first: "Synthetic", last: "Colleague", role: "Manager", email: `${row.id}-staff@example.test` }] } });
    expect(await confirmDesk(handle.db, row.id, "Synthetic Owner")).toBe(true);
    let metadata: Record<string, string> = {};
    const customer = `cus_${randomUUID()}`;
    const id = `seti_${randomUUID()}`;
    const stripe: SignupStripe = { customers: { create: async () => ({ id: customer }) }, setupIntents: { create: async (p) => { metadata = p.metadata; return { id, client_secret: "test_only" }; } } };
    await startPayment(handle.db, stripe, { ...row, details: { jurisdiction: "CA" } }, { plan: "full", term: "annual", locations: 1, brief: false, call: false, website: false, setupWeek: false });
    return { row, cdId, enrolment: proof.token, intent: { id, customer, status: "succeeded", paymentMethod: "pm_test", metadata } };
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
  it("the actual Canadian shop receives its approved identity, address and officer", async () => {
    const { row, intent } = await paymentReady();
    const opened = await openFromSetupIntent(handle.db, intent);
    expect(opened.opened).toBe(true);
    if (!opened.opened) throw new Error("not opened");
    const tenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, opened.tenantId)))[0]!;
    expect(tenant.setup).toMatchObject({ address: { unit: "204", city: "Toronto", region: "ON" }, phone: "+14165550142", compliance: { mode: "me", name: "Daniel Okafor", email: row.email }, currencies: ["CAD", "USD", "EUR"] });
    const entity = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, opened.tenantId)))[0]!;
    expect(entity).toMatchObject({ homeCurrency: "CAD", jurisdiction: "FINTRAC", jurisdictionPackId: "pack-ca-v2", jurisdictionPackVersion: 2, msbNumber: "M12345678" });
  });
  it("the proof browser enters the real shop API with its own tenant and permission scope", async () => {
    const { row, cdId, enrolment, intent } = await paymentReady();
    const opened = await openFromSetupIntent(handle.db, intent);
    if (!opened.opened) throw new Error("activation refused");
    const app = await buildApp(handle.db);
    try {
      const response = await app.inject({ method: "POST", url: `/api/onboarding/${cdId}/open`, cookies: { cd_enrol: enrolment } });
      expect(response.statusCode, response.body).toBe(200);
      const cookie = response.cookies.find(c => c.name === "cdos_session");
      expect(cookie).toBeDefined();
      const cookies = { cdos_session: cookie!.value };
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
      expect(me.json().user).toMatchObject({ id: row.email, name: "Daniel Okafor", role: "administrator", tenantId: opened.tenantId });
      const desk = await app.inject({ method: "GET", url: "/api/tenant?tenantId=tnt-yorkfx", cookies });
      expect(desk.json().tenant.id).toBe(opened.tenantId);
      expect(desk.json().tenant.setup.compliance.email).toBe(row.email);
      expect((await app.inject({ method: "GET", url: "/api/tenant", cookies: { cd_enrol: enrolment } })).statusCode).toBe(401);
      const member = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, `${row.id}-staff@example.test`)))[0]!;
      expect(member.role).toBe("branch_manager");
      expect(member.authorizedBranchIds).toEqual([member.branchId]);
      expect(backendRolePermissions[member.role]).not.toContain("compliance:thresholds");
      expect(backendRolePermissions.administrator).toContain("compliance:file");
    } finally { await app.close(); }
  });
  it("only a trusted staging runtime carries the test-shop marker through activation", async () => {
    const previous = { STAGING: process.env.STAGING, RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME };
    try {
      process.env.STAGING = "1";
      process.env.RENDER_EXTERNAL_HOSTNAME = "currencydesk-staging.onrender.com";
      const staged = await paymentReady(true);
      const opened = await openFromSetupIntent(handle.db, staged.intent);
      if (!opened.opened) throw new Error("activation refused");
      expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, opened.tenantId)))[0]?.isTestShop).toBe(true);
      process.env.RENDER_EXTERNAL_HOSTNAME = "currencydeskos.com";
      const live = await paymentReady(true);
      const liveOpened = await openFromSetupIntent(handle.db, live.intent);
      if (!liveOpened.opened) throw new Error("activation refused");
      expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, liveOpened.tenantId)))[0]?.isTestShop).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  it("signed records survive edits and re-signing and cannot be rewritten", async () => {
    const { row } = await paymentReady();
    await handle.db.update(schema.onboarding).set({ answers: { operatingName: "Changed shop", bizName: "Changed Shop Inc.", street: "2 Test", city: "Toronto", region: "ON", postal: "M1A 1A1", complianceMode: "me", currencies: ["CAD"], idOver: "1000" } }).where(eq(schema.onboarding.enquiryId, row.id));
    expect(await confirmDesk(handle.db, row.id, "Daniel Okafor")).toBe(true);
    const evidence = await handle.db.execute(sql`SELECT * FROM signup_agreements WHERE enquiry_id=${row.id} ORDER BY signed_at, id`);
    const rows = Array.isArray(evidence) ? evidence : evidence.rows;
    expect(rows.length).toBeGreaterThanOrEqual(3); // two desk records and the selected plan
    await expect(handle.db.execute(sql`UPDATE signup_agreements SET signer_name='forged' WHERE enquiry_id=${row.id}`)).rejects.toThrow();
    await expect(handle.db.execute(sql`DELETE FROM signup_agreements WHERE enquiry_id=${row.id}`)).rejects.toThrow();
  });
  it("a PIN audit failure cannot leave a changed PIN without evidence", async () => {
    const { row } = await paymentReady();
    await handle.db.execute(sql`CREATE OR REPLACE FUNCTION cd206_fail_pin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'signup.pin_set' THEN RAISE EXCEPTION 'synthetic PIN audit failure'; END IF; RETURN NEW; END $$`);
    await handle.db.execute(sql`CREATE TRIGGER cd206_fail_pin_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION cd206_fail_pin_audit()`);
    try {
      await expect(savePin(handle.db, row.id, "5397")).rejects.toThrow();
      expect((await loadAccount(handle.db, row.id)).pinHash).toBe("synthetic-never-used");
    } finally {
      await handle.db.execute(sql`DROP TRIGGER cd206_fail_pin_audit ON audit_events`);
      await handle.db.execute(sql`DROP FUNCTION cd206_fail_pin_audit()`);
    }
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
