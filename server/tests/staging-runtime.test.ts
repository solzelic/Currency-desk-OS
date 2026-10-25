/* Staging runtime and the two demo roles it will sign in later.
   Written before the module and the seed rows. A preview of the
   staging service is currencydesk-staging-pr-<number>.onrender.com.
   currencydesk-pr-<number> is a different service and is refused. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("demo seed adds the two missing roles once", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    process.env.SEED_PASSWORD = "yorkville";
    handle = await createDb();
    await seed(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  it("inserts a compliance officer and an auditor, and leaves an existing password alone", async () => {
    const id = `${DEMO.tenantId}:c.adebayo`;
    const officer = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, id)).then((rows) => rows[0]);
    const auditor = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:l.berg`)).then((rows) => rows[0]);
    expect(officer).toMatchObject({ staffId: "c.adebayo", name: "C. Adebayo", role: "compliance_officer", tenantId: DEMO.tenantId });
    expect(auditor).toMatchObject({ staffId: "l.berg", name: "L. Berg", role: "auditor", tenantId: DEMO.tenantId });
    expect(officer!.passwordHash).toBeTruthy();

    await handle.db.update(schema.staffUsers).set({ passwordHash: "already-chosen" }).where(eq(schema.staffUsers.id, id));
    await seed(handle.db);
    const again = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, id)).then((rows) => rows[0]);
    expect(again!.passwordHash).toBe("already-chosen");
    expect(again!.role).toBe("compliance_officer");
  });
});
