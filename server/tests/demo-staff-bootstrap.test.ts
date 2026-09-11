/* DEMO_STAFF_BOOTSTRAP is one-shot: create staff id `demo` on York FX if
   missing, never overwrite an existing demo password. Same spirit as
   PLATFORM_ADMIN_BOOTSTRAP (issue #31). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import {
  DEMO_STAFF_ID,
  demoStaffRowId,
  ensureDemoStaff,
  isDemoDeskTenant,
  parseDemoStaffBootstrap,
  shouldPopulateDemoDesk,
} from "../src/demo-desk.js";
import { DEMO, seed } from "../src/seed.js";

let handle: DbHandle;

const BOOTSTRAP = "first-demo-password-9";
const IN_APP = "in-app-demo-password-9";
const HOSTILE = "hostile-env-password-9";
const staffRowId = demoStaffRowId();

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
});
afterAll(async () => {
  await handle.close();
});

const staffRow = () =>
  handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, staffRowId)).limit(1).then((r) => r[0]);

describe("parseDemoStaffBootstrap", () => {
  it("accepts demo:password and refuses every other staff id", () => {
    expect(parseDemoStaffBootstrap("demo:long-enough")).toEqual({
      staffId: DEMO_STAFF_ID,
      password: "long-enough",
    });
    expect(parseDemoStaffBootstrap("demo:has:colons:inside")).toEqual({
      staffId: DEMO_STAFF_ID,
      password: "has:colons:inside",
    });
    expect(parseDemoStaffBootstrap("j.masri:long-enough")).toBeNull();
    expect(parseDemoStaffBootstrap("demo:short")).toBeNull();
    expect(parseDemoStaffBootstrap("demo")).toBeNull();
    expect(parseDemoStaffBootstrap("")).toBeNull();
    expect(parseDemoStaffBootstrap(undefined)).toBeNull();
  });
});

describe("isDemoDeskTenant / shouldPopulateDemoDesk", () => {
  it("recognises only York FX with siteSlug yorkfx", () => {
    expect(isDemoDeskTenant({ id: DEMO.tenantId, siteSlug: "yorkfx" })).toBe(true);
    expect(isDemoDeskTenant({ id: DEMO.tenantId, siteSlug: null })).toBe(false);
    expect(isDemoDeskTenant({ id: DEMO.tenantId, siteSlug: "other" })).toBe(false);
    expect(isDemoDeskTenant({ id: "tnt-customer", siteSlug: "yorkfx" })).toBe(false);
  });

  it("treats DEMO_POPULATE=1 or true as opt-in", () => {
    expect(shouldPopulateDemoDesk({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldPopulateDemoDesk({ DEMO_POPULATE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldPopulateDemoDesk({ DEMO_POPULATE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldPopulateDemoDesk({ DEMO_POPULATE: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("ensureDemoStaff", () => {
  it("creates the York FX demo teller on a fresh database", async () => {
    const result = await ensureDemoStaff(handle.db, BOOTSTRAP);
    expect(result).toBe("created");

    const user = await staffRow();
    expect(user).toBeTruthy();
    expect(user!.staffId).toBe(DEMO_STAFF_ID);
    expect(user!.tenantId).toBe(DEMO.tenantId);
    expect(user!.role).toBe("teller");
    expect(user!.mustChangePassword).toBe(false);
    expect(await verifyPassword(BOOTSTRAP, user!.passwordHash)).toBe(true);
  });

  it("does not overwrite passwordHash, mustChangePassword, or passwordUpdatedAt on a second run", async () => {
    const stamped = new Date("2026-04-01T12:00:00.000Z");
    await handle.db
      .update(schema.staffUsers)
      .set({
        passwordHash: await hashPassword(IN_APP),
        mustChangePassword: true,
        passwordUpdatedAt: stamped,
      })
      .where(eq(schema.staffUsers.id, staffRowId));
    const before = (await staffRow())!;

    const result = await ensureDemoStaff(handle.db, HOSTILE);
    expect(result).toBe("exists");

    const after = (await staffRow())!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(true);
    expect(after.passwordUpdatedAt?.getTime()).toBe(stamped.getTime());
    expect(await verifyPassword(IN_APP, after.passwordHash)).toBe(true);
    expect(await verifyPassword(HOSTILE, after.passwordHash)).toBe(false);
    expect(await verifyPassword(BOOTSTRAP, after.passwordHash)).toBe(false);
  });

  it("stamps a password once when the account exists but has never had one set", async () => {
    await handle.db
      .update(schema.staffUsers)
      .set({
        passwordHash: await hashPassword("placeholder-hash-xx"),
        passwordUpdatedAt: null,
        mustChangePassword: false,
      })
      .where(eq(schema.staffUsers.id, staffRowId));

    const result = await ensureDemoStaff(handle.db, IN_APP);
    expect(result).toBe("password_set");
    const after = (await staffRow())!;
    expect(after.passwordUpdatedAt).toBeTruthy();
    expect(await verifyPassword(IN_APP, after.passwordHash)).toBe(true);

    const again = await ensureDemoStaff(handle.db, HOSTILE);
    expect(again).toBe("exists");
    expect(await verifyPassword(IN_APP, (await staffRow())!.passwordHash)).toBe(true);
  });
});
