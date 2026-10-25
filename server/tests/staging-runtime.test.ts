/* Staging runtime and the two demo roles it will sign in later.
   Written before the module and the seed rows. A preview of the
   staging service is currencydesk-staging-pr-<number>.onrender.com.
   currencydesk-pr-<number> is a different service and is refused. */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { isStagingRuntime, requestHost } from "../src/auth/staging-runtime.js";

const PREVIEW = "currencydesk-staging-pr-5.onrender.com";
const FLAG = { STAGING: "1" } as NodeJS.ProcessEnv;

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
      "currencydesk-staging.onrender.com",
      "currencydeskos.com",
      "www.currencydeskos.com",
    ]) {
      expect(isStagingRuntime(host, env), host).toBe(false);
    }
  });

  it("allows the staging host, and a staging preview only with the flag and IS_PULL_REQUEST", () => {
    expect(isStagingRuntime("staging.currencydeskos.com", FLAG)).toBe(true);
    expect(isStagingRuntime("staging.currencydeskos.com:443", FLAG)).toBe(true);
    expect(isStagingRuntime("staging.currencydeskos.com", {})).toBe(false);
    expect(isStagingRuntime(PREVIEW, FLAG)).toBe(false);
    expect(isStagingRuntime(PREVIEW, { ...FLAG, IS_PULL_REQUEST: "true" })).toBe(true);
    expect(isStagingRuntime(PREVIEW, { IS_PULL_REQUEST: "true" })).toBe(false);
  });
});

const STAGING_STAFF = ["c.adebayo", "l.berg"];

describe("demo seed adds the two roles only when STAGING=1", () => {
  const saved = {
    STAGING: process.env.STAGING,
    PGLITE_MEMORY: process.env.PGLITE_MEMORY,
    SEED_PASSWORD: process.env.SEED_PASSWORD,
  };
  afterEach(() => {
    for (const key of ["STAGING", "PGLITE_MEMORY", "SEED_PASSWORD"] as const) {
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
