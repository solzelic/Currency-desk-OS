/* PLATFORM_ADMIN_BOOTSTRAP is one-shot: create if missing, never overwrite
   an existing operator password (issue #31). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { ensurePlatformAdmin, PLATFORM_TENANT } from "../src/admin-bootstrap.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

let handle: DbHandle;

const EMAIL = "ops@currencydesk.test";
const BOOTSTRAP = "first-boot-password-9";
const OPERATOR = "in-app-operator-password-9";
const HOSTILE = "hostile-env-password-9";
const staffRowId = `${PLATFORM_TENANT}:${EMAIL}`;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
});
afterAll(async () => {
  await handle.close();
});

const staffRow = () =>
  handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, staffRowId)).limit(1).then((r) => r[0]);

describe("ensurePlatformAdmin", () => {
  it("creates the platform admin and tenant scaffolding on a fresh database", async () => {
    const result = await ensurePlatformAdmin(handle.db, EMAIL, BOOTSTRAP);
    expect(result).toBe("created");

    const user = await staffRow();
    expect(user).toBeTruthy();
    expect(user!.staffId).toBe(EMAIL);
    expect(user!.role).toBe("administrator");
    expect(user!.mustChangePassword).toBe(false);
    expect(await verifyPassword(BOOTSTRAP, user!.passwordHash)).toBe(true);

    expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, PLATFORM_TENANT))).length).toBe(1);
    expect((await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.id, "le-platform"))).length).toBe(1);
    expect((await handle.db.select().from(schema.branches).where(eq(schema.branches.id, "br-platform"))).length).toBe(1);
    expect((await handle.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, "ws-platform-till"))).length).toBe(1);
  });

  it("does not overwrite passwordHash, mustChangePassword, or passwordUpdatedAt when bootstrap runs again with a different password", async () => {
    const stamped = new Date("2026-04-01T12:00:00.000Z");
    await handle.db
      .update(schema.staffUsers)
      .set({
        passwordHash: await hashPassword(OPERATOR),
        mustChangePassword: true,
        passwordUpdatedAt: stamped,
      })
      .where(eq(schema.staffUsers.id, staffRowId));
    const before = (await staffRow())!;

    const result = await ensurePlatformAdmin(handle.db, EMAIL, HOSTILE);
    expect(result).toBe("exists");

    const after = (await staffRow())!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(true);
    expect(after.passwordUpdatedAt?.getTime()).toBe(stamped.getTime());
    expect(await verifyPassword(OPERATOR, after.passwordHash)).toBe(true);
    expect(await verifyPassword(HOSTILE, after.passwordHash)).toBe(false);
    expect(await verifyPassword(BOOTSTRAP, after.passwordHash)).toBe(false);

    // scaffolding is still present (re-run is onConflictDoNothing, not a wipe)
    expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, PLATFORM_TENANT))).length).toBe(1);
  });
});
