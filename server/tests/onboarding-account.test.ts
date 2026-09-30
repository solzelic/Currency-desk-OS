/* The public account door.
   Terms have to be accepted before an account exists, and the
   CurrencyDesk ID comes back from the account — it is not a field
   the request is allowed to send. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { ACCOUNT_TERMS_VERSION } from "../src/routes/onboarding-account.js";

let handle: DbHandle;
let app: FastifyInstance;

const ISSUED = /^CD-[2-9A-HJ-NP-Z]{6}$/;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  /* Deliberately not EARLY_ACCESS_OPEN. This door must not depend on
     an operator having already invited the address. */
  delete process.env.EARLY_ACCESS_OPEN;
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

function account(over: Record<string, unknown> = {}) {
  return {
    businessName: "Harbour Exchange",
    ownerName: "Nora Hale",
    email: "nora@harbour.example",
    password: "a-strong-pass",
    termsAccepted: true,
    termsVersion: ACCOUNT_TERMS_VERSION,
    ...over,
  };
}

async function tenantCount(): Promise<number> {
  return (await handle.db.select({ id: schema.tenants.id }).from(schema.tenants)).length;
}

describe("public account opening", () => {
  it("will not continue until the current terms are accepted", async () => {
    const before = await tenantCount();
    const missing = await app.inject({
      method: "POST",
      url: "/api/onboarding/account",
      payload: account({ termsAccepted: undefined }),
    });
    expect(missing.statusCode).toBe(400);

    const refused = await app.inject({
      method: "POST",
      url: "/api/onboarding/account",
      payload: account({ termsAccepted: false }),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().detail).toMatch(/terms/i);

    const stale = await app.inject({
      method: "POST",
      url: "/api/onboarding/account",
      payload: account({ termsVersion: "1999-01-01" }),
    });
    expect(stale.statusCode).toBe(400);
    expect(await tenantCount()).toBe(before);
  });

  it("issues the ID from the account and does not take one as input", async () => {
    const before = await tenantCount();
    const supplied = "CD-AAAAAA";
    const rejected = await app.inject({
      method: "POST",
      url: "/api/onboarding/account",
      payload: account({ reference: supplied, email: "smuggle@harbour.example" }),
    });
    expect(rejected.statusCode).toBe(400);
    expect(await tenantCount()).toBe(before);
    const planted = await handle.db.select().from(schema.tenants).where(eq(schema.tenants.reference, supplied));
    expect(planted.length).toBe(0);

    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/account",
      payload: account(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reference).toMatch(ISSUED);
    expect(body.reference).not.toBe(supplied);
    expect(JSON.stringify(account())).not.toContain(body.reference);
    expect(res.cookies.find((c) => c.name === "cdos_session")?.value).toBeTruthy();

    const row = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, body.tenant.id)))[0];
    expect(row?.reference).toBe(body.reference);
    expect(row?.termsVersion).toBe(ACCOUNT_TERMS_VERSION);
    expect(row?.termsAcceptedAt).toBeInstanceOf(Date);

    const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "nora@harbour.example"));
    expect(owner[0]).toMatchObject({ role: "administrator", tenantId: body.tenant.id });

    const other = await app.inject({
      method: "POST",
      url: "/api/onboarding/account",
      payload: account({
        businessName: "Second Harbour",
        ownerName: "Ida Cole",
        email: "ida@harbour.example",
      }),
    });
    expect(other.statusCode).toBe(201);
    expect(other.json().reference).toMatch(ISSUED);
    expect(other.json().reference).not.toBe(body.reference);
  });

  it("tells the page which terms version it must send back", async () => {
    const res = await app.inject({ method: "GET", url: "/api/onboarding/account/terms" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: ACCOUNT_TERMS_VERSION, href: "/legal#terms" });
  });
});
