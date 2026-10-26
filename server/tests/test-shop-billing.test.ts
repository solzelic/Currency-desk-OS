/* A launched test shop must not reach Stripe. Each call site is
   exercised with a fake client, and that client records zero calls. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { createSession } from "../src/auth/sessions.js";
import { reportKycUsage } from "../src/routes/billing.js";

const calls = vi.hoisted(() => ({ list: 0, create: 0, checkout: 0, portal: 0, meter: 0 }));

vi.mock("../src/billing/stripe.js", async () => {
  const actual = await vi.importActual<typeof import("../src/billing/stripe.js")>("../src/billing/stripe.js");
  return {
    ...actual,
    stripeClient: () => ({
      customers: {
        list: async () => { calls.list += 1; return { data: [] }; },
        create: async () => { calls.create += 1; return { id: `cus_${randomUUID()}` }; },
      },
      checkout: { sessions: { create: async () => { calls.checkout += 1; return { id: "cs_fake", url: "https://checkout.stripe.test/pay" }; } } },
      billingPortal: { sessions: { create: async () => { calls.portal += 1; return { url: "https://billing.stripe.test/portal" }; } } },
      billing: { meterEvents: { create: async () => { calls.meter += 1; return {}; } } },
    }),
  };
});

let handle: DbHandle;
let app: FastifyInstance;
let realCookie: Record<string, string>;
let listCookie: Record<string, string>;
let createCookie: Record<string, string>;
let sessionCookie: Record<string, string>;
let portalCookie: Record<string, string>;

const checkout = (cookies: Record<string, string>) => app.inject({
  method: "POST", url: "/api/billing/checkout", cookies,
  payload: { plan: "pro", cycle: "monthly", idempotencyKey: randomUUID() },
});

async function shop(id: string, staffId: string, testShop: boolean): Promise<Record<string, string>> {
  await handle.db.insert(schema.tenants).values({ id, name: id, plan: "trial", isTestShop: testShop });
  await handle.db.insert(schema.legalEntities).values({ id: `le-${id}`, tenantId: id, name: id });
  await handle.db.insert(schema.branches).values({ id: `br-${id}`, tenantId: id, legalEntityId: `le-${id}`, name: "Desk" });
  const userId = `staff-${id}`;
  await handle.db.insert(schema.staffUsers).values({
    id: userId, tenantId: id, legalEntityId: `le-${id}`, branchId: `br-${id}`,
    staffId, name: "Owner", role: "administrator", authorizedBranchIds: [`br-${id}`], passwordHash: "x",
  });
  const { token } = await createSession(handle.db, userId);
  return { cdos_session: token };
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_currencydesk";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_month";
  process.env.APP_BASE_URL = "https://app.currencydesk.test";
  process.env.STRIPE_KYC_METER_EVENT_NAME = "kyc_verification";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: DEMO.tenantId } });
  realCookie = { cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value };
  listCookie = await shop("tnt-list", "owner+list@staging.invalid", true);
  createCookie = await shop("tnt-create", "owner-create", true);
  sessionCookie = await shop("tnt-session", "owner-session", true);
  portalCookie = await shop("tnt-portal", "owner-portal", true);
  await handle.db.insert(schema.tenants).values({ id: "tnt-meter", name: "meter", plan: "trial", isTestShop: true });
  const now = new Date();
  await handle.db.insert(schema.stripeCustomers).values([
    { tenantId: "tnt-session", stripeCustomerId: "cus_session", createdAt: now, updatedAt: now },
    { tenantId: "tnt-portal", stripeCustomerId: "cus_portal", createdAt: now, updatedAt: now },
    { tenantId: "tnt-meter", stripeCustomerId: "cus_meter", createdAt: now, updatedAt: now },
  ]);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.APP_BASE_URL;
  delete process.env.STRIPE_KYC_METER_EVENT_NAME;
});

beforeEach(() => {
  calls.list = 0; calls.create = 0; calls.checkout = 0; calls.portal = 0; calls.meter = 0;
});

describe("test shops never call Stripe", () => {
  it("does not list customers", async () => {
    const res = await checkout(listCookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "TEST_SHOP" });
    expect(String(res.json().detail)).toMatch(/Test shops can't use billing/);
    expect(calls.list).toBe(0);
  });

  it("does not create a customer", async () => {
    const res = await checkout(createCookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("TEST_SHOP");
    expect(calls.create).toBe(0);
  });

  it("does not open a checkout session", async () => {
    const res = await checkout(sessionCookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("TEST_SHOP");
    expect(calls.checkout).toBe(0);
  });

  it("does not open the billing portal", async () => {
    const res = await app.inject({ method: "POST", url: "/api/billing/portal", cookies: portalCookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("TEST_SHOP");
    expect(calls.portal).toBe(0);
  });

  it("does not send a meter event", async () => {
    await expect(reportKycUsage(handle.db, "tnt-meter", "ver_1")).rejects.toMatchObject({ code: "TEST_SHOP" });
    expect(calls.meter).toBe(0);
  });

  it("still checks out a real shop", async () => {
    const res = await checkout(realCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe("https://checkout.stripe.test/pay");
    expect(calls.create).toBe(1);
    expect(calls.checkout).toBe(1);
  });
});
