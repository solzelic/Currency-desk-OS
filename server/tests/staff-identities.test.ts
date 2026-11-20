/* CD-273. The identity tables exist. Nothing here signs anyone in. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";
import { seed } from "../src/seed.js";
import { SIGN_IN_AUDIT, signInAuditDetail } from "../src/auth/signin-audit.js";

let handle: DbHandle;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
});

afterAll(async () => {
  await handle.close();
});

describe("staff sign-in identity tables", () => {
  it("is registered as migration 083 and does not replace an older file", () => {
    expect(migrations.some(([id]) => id === "083_staff_sign_in_identities")).toBe(true);
    expect(migrations.some(([id]) => id === "082_pep_answer_events")).toBe(true);
  });

  it("keeps the Microsoft allowlist off until a shop sets it", async () => {
    const row = (await handle.db.select({ list: schema.tenants.msTenantAllowlist }).from(schema.tenants).where(eq(schema.tenants.id, "tnt-yorkfx")).limit(1))[0];
    expect(row?.list ?? null).toBeNull();
  });

  it("allows one subject in two shops and refuses a second link in the same shop", async () => {
    const subject = `sub-${randomUUID()}`;
    const issuer = "https://accounts.google.com";
    const other = `tnt-${randomUUID().slice(0, 8)}`;
    await handle.db.insert(schema.tenants).values({ id: other, name: "Other desk" });
    await handle.db.insert(schema.legalEntities).values({ id: `le-${other}`, tenantId: other, name: "Other", jurisdiction: "FINTRAC" });
    await handle.db.insert(schema.branches).values({ id: `br-${other}`, tenantId: other, legalEntityId: `le-${other}`, name: "Main", province: "ON" });
    await handle.db.insert(schema.staffUsers).values({
      id: `${other}:owner`, tenantId: other, legalEntityId: `le-${other}`, branchId: `br-${other}`,
      staffId: "owner", name: "Owner", role: "administrator", authorizedBranchIds: [`br-${other}`], passwordHash: "x",
    });
    await handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`, tenantId: "tnt-yorkfx", staffUserId: "tnt-yorkfx:j.masri",
      provider: "google", issuer, subject,
    });
    await expect(handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`, tenantId: "tnt-yorkfx", staffUserId: "tnt-yorkfx:m.costa",
      provider: "google", issuer, subject,
    })).rejects.toThrow();
    await handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`, tenantId: other, staffUserId: `${other}:owner`,
      provider: "google", issuer, subject,
    });
    await expect(handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`, tenantId: "tnt-yorkfx", staffUserId: "tnt-yorkfx:j.masri",
      provider: "google", issuer: "https://accounts.google.com", subject: `other-${subject}`,
    })).rejects.toThrow();
    await handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`, tenantId: "tnt-yorkfx", staffUserId: "tnt-yorkfx:j.masri",
      provider: "microsoft", issuer: "https://login.microsoftonline.com/tid/v2.0", subject: `oid-${subject}`, msTid: "tid",
    });
  });

  it("stores a recovery code hash column and a step-up marker column", async () => {
    const tables = await handle.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('staff_identities', 'staff_passkeys', 'auth_challenges', 'staff_recovery_codes', 'staff_totp')
    `);
    const names = tables.rows.map((row) => String((row as { table_name: string }).table_name)).sort();
    expect(names).toEqual(["auth_challenges", "staff_identities", "staff_passkeys", "staff_recovery_codes", "staff_totp"]);
    const step = await handle.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name = 'step_up_at'
    `);
    expect(step.rows).toHaveLength(1);
    const tenants = await handle.db.execute(sql`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE column_name = 'tenant_id' AND table_name IN ('auth_challenges', 'staff_recovery_codes')
    `);
    const required = tenants.rows.map((row) => `${(row as { table_name: string }).table_name}:${(row as { is_nullable: string }).is_nullable}`).sort();
    expect(required).toEqual(["auth_challenges:NO", "staff_recovery_codes:NO"]);
  });

  it("strips secrets from the audit detail allow-list", () => {
    expect(SIGN_IN_AUDIT.linked).toBe("auth.identity_linked");
    expect(signInAuditDetail({
      method: "google",
      issuer: "https://accounts.google.com",
      result: "ok",
      emailed: false,
      email: "person@example.com",
      Email: "person@example.com",
      accessToken: "ya29",
      backupCode: "abcde",
      nested: { code: "123456", shop: "tnt" },
    })).toEqual({
      method: "google",
      issuer: "https://accounts.google.com",
      result: "ok",
      emailed: false,
      nested: { shop: "tnt" },
    });
  });
});
