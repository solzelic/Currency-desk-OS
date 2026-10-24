/* Per-shop identity verification settings. Owner only. Shop A cannot
   read or write shop B. A non-owner is refused. A key value is not
   stored. The provider defaults to the registered default. With checks
   off, a teller still signs in. */
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { OWNER_ONLY } from "../src/idv/shop-config.js";
import { defaultIdvProvider } from "../src/idv/providers/index.js";

const ROUTE = "/api/settings/idv";
const PROVIDER = defaultIdvProvider().id;
const B = {
  tenantId: "tnt-idv-b",
  legalEntityId: "le-idv-b",
  branchId: "br-idv-b",
  userId: "tnt-idv-b:b.owner",
  staffId: "b.owner",
};

let handle: DbHandle;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
const logged: string[] = [];

function cookieOf(res: { cookies: { name: string; value: string }[] }) {
  return { cdos_session: res.cookies.find((item) => item.name === "cdos_session")!.value };
}

async function signIn(staffId: string, tenantId: string) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
}

const read = (who: string, query = "") =>
  app.inject({ method: "GET", url: ROUTE + query, cookies: cookies[who] });
const write = (who: string, payload: unknown) =>
  app.inject({ method: "PUT", url: ROUTE, cookies: cookies[who], payload: payload as Record<string, unknown> });
const stored = (shopId: string) =>
  handle.db.select().from(schema.idvShopConfig).where(eq(schema.idvShopConfig.shopId, shopId)).then((rows) => rows[0] ?? null);

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "j.masri")).limit(1);
  await handle.db.insert(schema.tenants).values({ id: B.tenantId, name: "Shop B" });
  await handle.db.insert(schema.legalEntities).values({
    id: B.legalEntityId, tenantId: B.tenantId, name: "Shop B", jurisdiction: "FINTRAC",
  });
  await handle.db.insert(schema.branches).values({
    id: B.branchId, tenantId: B.tenantId, legalEntityId: B.legalEntityId, name: "Shop B counter",
  });
  await handle.db.insert(schema.staffUsers).values({
    id: B.userId, tenantId: B.tenantId, legalEntityId: B.legalEntityId, branchId: B.branchId,
    staffId: B.staffId, name: "B Owner", role: "administrator",
    authorizedBranchIds: [B.branchId], passwordHash: owner[0]!.passwordHash,
  });
  const sink = new PassThrough();
  sink.on("data", (chunk) => logged.push(String(chunk)));
  app = await buildApp(handle.db, {}, sink);
  cookies.owner = await signIn("j.masri", DEMO.tenantId);
  cookies.manager = await signIn("r.haddad", DEMO.tenantId);
  cookies.teller = await signIn("m.costa", DEMO.tenantId);
  cookies.b = await signIn(B.staffId, B.tenantId);
});

afterAll(async () => {
  if (app) await app.close();
  if (handle) await handle.close();
});

describe("per-shop identity verification settings", () => {
  it("is off until the owner saves, and a non-owner is refused", async () => {
    expect(PROVIDER).toBe("persona");
    const fresh = await read("owner");
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({
      shopId: DEMO.legalEntityId, provider: PROVIDER, apiKeyRef: null, templateId: null, retentionDays: null, checksEnabled: false,
    });
    expect(await stored(DEMO.legalEntityId)).toBeNull();
    for (const who of ["manager", "teller"]) {
      expect((await read(who)).statusCode).toBe(403);
      expect((await read(who)).json()).toEqual({ code: "AUTHORIZATION_DENIED", message: OWNER_ONLY });
      const put = await write(who, { apiKeyRef: "teller-name", checksEnabled: true, shopId: B.legalEntityId });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toEqual({ code: "AUTHORIZATION_DENIED", message: OWNER_ONLY });
    }
    expect(await stored(DEMO.legalEntityId)).toBeNull();
    expect(await stored(B.legalEntityId)).toBeNull();
    expect((await app.inject({ method: "GET", url: ROUTE })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: ROUTE, payload: { checksEnabled: true } })).statusCode).toBe(401);
  });

  it("lets shop A neither read nor write shop B", async () => {
    const savedB = await write("b", {
      apiKeyRef: "SHOP_B_REF", templateId: "itmpl_shop_b", retentionDays: 30, checksEnabled: false, shopId: DEMO.legalEntityId,
    });
    expect(savedB.statusCode, savedB.body).toBe(200);
    expect(savedB.json().shopId).toBe(B.legalEntityId);
    expect(savedB.json().provider).toBe(PROVIDER);
    const savedA = await write("owner", {
      apiKeyRef: "SANDBOX_SHARED", templateId: "itmpl_shop_a", retentionDays: 1825, checksEnabled: false, shopId: B.legalEntityId,
    });
    expect(savedA.json()).toEqual({
      shopId: DEMO.legalEntityId, provider: PROVIDER, apiKeyRef: "SANDBOX_SHARED", templateId: "itmpl_shop_a", retentionDays: 1825, checksEnabled: false,
    });
    expect((await read("owner", `?shopId=${B.legalEntityId}`)).json()).toMatchObject({
      shopId: DEMO.legalEntityId, apiKeyRef: "SANDBOX_SHARED",
    });
    expect((await read("b", `?shopId=${DEMO.legalEntityId}`)).json()).toMatchObject({
      shopId: B.legalEntityId, apiKeyRef: "SHOP_B_REF", checksEnabled: false,
    });
    expect(await stored(B.legalEntityId)).toMatchObject({ provider: PROVIDER, apiKeyRef: "SHOP_B_REF", templateId: "itmpl_shop_b", retentionDays: 30, checksEnabled: false });
    expect(await stored(DEMO.legalEntityId)).toMatchObject({ provider: PROVIDER, apiKeyRef: "SANDBOX_SHARED", checksEnabled: false });
  });

  it("refuses a key value and leaves both shops unchanged", async () => {
    const beforeA = await stored(DEMO.legalEntityId);
    const beforeB = await stored(B.legalEntityId);
    const secrets = [
      "sk_live_FAKECHECKVALUE000000000000", "sk_test_FAKECHECKVALUE000000000000",
      "ghp_FAKECHECKVALUE0000000000000000", "persona_FAKECHECKVALUE000000000",
      "k7Qm9xL2pV4nR8wT1cY6bH3dF5sJ0aZeU8iO3",
    ];
    for (const apiKeyRef of secrets) {
      const refused = await write("owner", { apiKeyRef, checksEnabled: true, shopId: B.legalEntityId });
      expect(refused.statusCode).toBe(400);
      expect(JSON.stringify(refused.json()) + logged.join("")).not.toContain(apiKeyRef);
      expect(await stored(DEMO.legalEntityId)).toEqual(beforeA);
      expect(await stored(B.legalEntityId)).toEqual(beforeB);
    }
    const field = await write("owner", { apiKey: "not-stored", apiKeyRef: "SANDBOX_SHARED" });
    expect(field.statusCode).toBe(400);
    expect(field.json().message).toBe("This route does not accept that field.");
    expect(JSON.stringify(field.json()) + logged.join("")).not.toContain("not-stored");
    const days = await write("owner", { retentionDays: 0 });
    expect(days.statusCode).toBe(422);
    const unknown = await write("owner", { provider: "other" });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().message).toBe("That identity provider is not available.");
    const template = await write("owner", { templateId: "shop-template" });
    expect(template.statusCode).toBe(422);
    expect(template.json().message).toBe("The template id is not valid for this provider.");
    const bodies: unknown[] = [
      { checksEnabled: "yes" }, { retentionDays: "30" }, { retentionDays: 1.5 },
      { templateId: 5 }, ["itmpl_shop_a"], { foo: 1 },
    ];
    for (const payload of bodies) {
      const bad = await write("owner", payload);
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
      expect(JSON.stringify(bad.json())).not.toMatch(/yes|itmpl_shop_a|"foo"/);
      expect(await stored(DEMO.legalEntityId)).toEqual(beforeA);
      expect(await stored(B.legalEntityId)).toEqual(beforeB);
    }
  });

  it("stays off when the flag is omitted, and a teller still signs in", async () => {
    const res = await write("owner", { apiKeyRef: "SANDBOX_SHARED", templateId: "itmpl_shop_a", retentionDays: 1825 });
    expect(res.json().checksEnabled).toBe(false);
    expect(res.json().provider).toBe(PROVIDER);
    const teller = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { staffId: "m.costa", password: DEMO.password, tenantId: DEMO.tenantId },
    });
    expect(teller.statusCode).toBe(200);
  });
});
