/* Staging runtime and the two demo roles it will sign in later.
   Written before the module and the seed rows. A preview of the
   staging service is currencydesk-staging-pr-<number>.onrender.com.
   currencydesk-pr-<number> is a different service and is refused. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { verifyPassword } from "../src/auth/password.js";
import { isStagingRuntime, requestHost } from "../src/auth/staging-runtime.js";

const PREVIEW = "currencydesk-staging-pr-5.onrender.com";
const FLAG = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "staging.currencydeskos.com" } as NodeJS.ProcessEnv;
const PREVIEW_ENV = { STAGING: "1", IS_PULL_REQUEST: "true", RENDER_EXTERNAL_HOSTNAME: PREVIEW } as NodeJS.ProcessEnv;

beforeEach(() => {
  expect(process.env.STAGING, "STAGING").toBeUndefined();
  expect(process.env.IS_PULL_REQUEST, "IS_PULL_REQUEST").toBeUndefined();
  expect(process.env.RENDER_EXTERNAL_HOSTNAME, "RENDER_EXTERNAL_HOSTNAME").toBeUndefined();
});

describe("isStagingRuntime", () => {
  it("reads the Host header the app already trusts", () => {
    expect(requestHost("Staging.CurrencyDeskOS.com:443")).toBe("staging.currencydeskos.com");
    expect(requestHost(["staging.currencydeskos.com", "currencydeskos.com"])).toBe("staging.currencydeskos.com");
    expect(requestHost("currencydesk-staging-pr-5.onrender.com.")).toBe(PREVIEW);
    expect(requestHost(undefined)).toBe("");
  });

  it("refuses the live service, the wrong preview name, and lookalikes", () => {
    const env = { ...FLAG, IS_PULL_REQUEST: "true" };
    for (const host of [
      "currencydesk-pr-5.onrender.com",
      "currencydesk.onrender.com",
      "currencydesk-staging.onrender.com.evil.com",
      "xcurrencydesk-staging-pr-5.onrender.com",
      "currencydeskos.com",
      "www.currencydeskos.com",
    ]) {
      expect(isStagingRuntime(host, env), host).toBe(false);
    }
  });

  it("allows the staging host, and a staging preview only with the flag and IS_PULL_REQUEST", () => {
    expect(isStagingRuntime("staging.currencydeskos.com", FLAG)).toBe(true);
    expect(isStagingRuntime("staging.currencydeskos.com:443", FLAG)).toBe(true);
    expect(isStagingRuntime("currencydesk-staging.onrender.com", { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" })).toBe(true);
    expect(isStagingRuntime("staging.currencydeskos.com", {})).toBe(false);
    expect(isStagingRuntime(PREVIEW, FLAG)).toBe(false);
    expect(isStagingRuntime(PREVIEW, PREVIEW_ENV)).toBe(true);
    expect(isStagingRuntime(PREVIEW, { IS_PULL_REQUEST: "true", RENDER_EXTERNAL_HOSTNAME: PREVIEW })).toBe(false);
  });

  it("refuses a preview whose number is not digits", () => {
    for (const host of [
      "currencydesk-staging-pr-x.onrender.com",
      "currencydesk-staging-pr-1a.onrender.com",
      "currencydesk-staging-pr-.onrender.com",
    ]) {
      expect(isStagingRuntime(host, { STAGING: "1", IS_PULL_REQUEST: "true", RENDER_EXTERNAL_HOSTNAME: host }), host).toBe(false);
    }
  });

  it("counts only the exact string 1 as the flag", () => {
    for (const flag of ["true", "yes", "", " 1", "1 "]) {
      expect(isStagingRuntime("staging.currencydeskos.com", { STAGING: flag, RENDER_EXTERNAL_HOSTNAME: "staging.currencydeskos.com" }), JSON.stringify(flag)).toBe(false);
    }
  });

  it("refuses a spoofed Host when Render's hostname is live or unset", () => {
    expect(isStagingRuntime("staging.currencydeskos.com", { STAGING: "1" })).toBe(false);
    expect(isStagingRuntime("staging.currencydeskos.com", { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydeskos.com" })).toBe(false);
    expect(isStagingRuntime("staging.currencydeskos.com", { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk.onrender.com" })).toBe(false);
    expect(isStagingRuntime("currencydeskos.com", { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydeskos.com" })).toBe(false);
  });
});

const STAGING_STAFF = ["c.adebayo", "l.berg"];

describe("demo seed adds the two roles only when STAGING=1", () => {
  const saved = {
    STAGING: process.env.STAGING,
    IS_PULL_REQUEST: process.env.IS_PULL_REQUEST,
    RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
    PGLITE_MEMORY: process.env.PGLITE_MEMORY,
    SEED_PASSWORD: process.env.SEED_PASSWORD,
  };
  afterEach(() => {
    for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function seeded(staging: string | undefined) {
    if (staging === undefined) delete process.env.STAGING;
    else process.env.STAGING = staging;
    process.env.PGLITE_MEMORY = "1";
    process.env.SEED_PASSWORD = "yorkville";
    const handle = await createDb();
    await seed(handle.db);
    return handle;
  }

  async function ids(handle: DbHandle) {
    const rows = await handle.db.select({ staffId: schema.staffUsers.staffId }).from(schema.staffUsers).where(eq(schema.staffUsers.tenantId, DEMO.tenantId));
    return rows.map((row) => row.staffId);
  }

  it("creates neither account when STAGING is unset", async () => {
    const handle = await seeded(undefined);
    try {
      const found = await ids(handle);
      expect(found).not.toContain("c.adebayo");
      expect(found).not.toContain("l.berg");
      expect(found).toContain("j.masri");
    } finally {
      await handle.close();
    }
  });

  it("creates neither account when STAGING=0", async () => {
    const handle = await seeded("0");
    try {
      const found = await ids(handle);
      for (const staffId of STAGING_STAFF) expect(found, staffId).not.toContain(staffId);
    } finally {
      await handle.close();
    }
  });

  it("creates neither account when STAGING is true", async () => {
    const handle = await seeded("true");
    try {
      const found = await ids(handle);
      for (const staffId of STAGING_STAFF) expect(found, staffId).not.toContain(staffId);
    } finally {
      await handle.close();
    }
  });

  it("does not use the yorkville fallback when SEED_PASSWORD is unset", async () => {
    delete process.env.SEED_PASSWORD;
    process.env.STAGING = "1";
    process.env.PGLITE_MEMORY = "1";
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const handle = await createDb();
    try {
      await seed(handle.db);
      const officer = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:c.adebayo`)).then((rows) => rows[0]);
      const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:j.masri`)).then((rows) => rows[0]);
      expect(officer).toMatchObject({ role: "compliance_officer" });
      expect(await verifyPassword("yorkville", officer!.passwordHash)).toBe(false);
      expect(await verifyPassword("yorkville", owner!.passwordHash)).toBe(true);
      expect(lines).toEqual(["Password sign-in is off for staging staff."]);
    } finally {
      console.log = orig;
      await handle.close();
    }
  });

  it("adds the two roles on an already-populated database and does not overwrite a row", async () => {
    const handle = await seeded(undefined);
    try {
      const ownerId = `${DEMO.tenantId}:j.masri`;
      await handle.db.update(schema.staffUsers).set({ passwordHash: "owner-chosen", name: "Kept" }).where(eq(schema.staffUsers.id, ownerId));
      process.env.STAGING = "1";
      await seed(handle.db);
      const found = await ids(handle);
      expect(found).toContain("c.adebayo");
      expect(found).toContain("l.berg");
      const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, ownerId)).then((rows) => rows[0]);
      expect(owner).toMatchObject({ passwordHash: "owner-chosen", name: "Kept", role: "administrator" });
      const officerId = `${DEMO.tenantId}:c.adebayo`;
      await handle.db.update(schema.staffUsers).set({ passwordHash: "officer-chosen" }).where(eq(schema.staffUsers.id, officerId));
      await seed(handle.db);
      const officer = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, officerId)).then((rows) => rows[0]);
      const ownerAgain = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, ownerId)).then((rows) => rows[0]);
      expect(officer!.passwordHash).toBe("officer-chosen");
      expect(ownerAgain).toMatchObject({ passwordHash: "owner-chosen", name: "Kept" });
    } finally {
      await handle.close();
    }
  });

  it("creates both when STAGING=1, and a second seed leaves the password alone", async () => {
    const handle = await seeded("1");
    try {
      const officerId = `${DEMO.tenantId}:c.adebayo`;
      const officer = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, officerId)).then((rows) => rows[0]);
      const auditor = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:l.berg`)).then((rows) => rows[0]);
      expect(officer).toMatchObject({ staffId: "c.adebayo", name: "C. Adebayo", role: "compliance_officer", tenantId: DEMO.tenantId });
      expect(auditor).toMatchObject({ staffId: "l.berg", name: "L. Berg", role: "auditor", tenantId: DEMO.tenantId });
      await handle.db.update(schema.staffUsers).set({ passwordHash: "already-chosen" }).where(eq(schema.staffUsers.id, officerId));
      await seed(handle.db);
      const again = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, officerId)).then((rows) => rows[0]);
      expect(again!.passwordHash).toBe("already-chosen");
      expect(again!.role).toBe("compliance_officer");
    } finally {
      await handle.close();
    }
  });
});
