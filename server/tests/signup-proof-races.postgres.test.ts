import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { loadAccount, saveCredential } from "../src/onboarding/signup-account.js";
import { sendSignupCode, verifySignupCode } from "../src/onboarding/email-code.js";
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
});
