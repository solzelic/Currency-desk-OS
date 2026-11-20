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

  it("allows the same IdP identity on two staff rows and refuses a duplicate link", async () => {
    const base = {
      tenantId: "tnt-yorkfx",
      provider: "google",
      issuer: "https://accounts.google.com",
      subject: "sub-shared",
    };
    await handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`,
      staffUserId: "tnt-yorkfx:j.masri",
      ...base,
    });
    await handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`,
      staffUserId: "tnt-yorkfx:m.costa",
      ...base,
    });
    await expect(handle.db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`,
      staffUserId: "tnt-yorkfx:j.masri",
      ...base,
    })).rejects.toThrow();
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
  });

  it("strips secrets from the audit detail allow-list", () => {
    expect(SIGN_IN_AUDIT.linked).toBe("auth.identity_linked");
    expect(signInAuditDetail({
      method: "google",
      issuer: "https://accounts.google.com",
      result: "ok",
      email: "person@example.com",
      id_token: "eyJ",
      access_token: "ya29",
      code: "123456",
    })).toEqual({
      method: "google",
      issuer: "https://accounts.google.com",
      result: "ok",
    });
  });
});
