import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
const webhookSecret = "whsec_currencydesk_test";
const stripe = new Stripe("sk_test_currencydesk", { apiVersion: "2026-06-24.dahlia" });

const event = (id: string, type: string, data: Record<string, unknown>) => JSON.stringify({
  id, object: "event", type, livemode: false, data: { object: data },
});

const send = async (payload: string) => app.inject({
  method: "POST", url: "/api/billing/webhook", payload,
  headers: { "content-type": "application/json", "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret }) },
});

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_currencydesk";
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_month";
  process.env.STRIPE_PRICE_BASIC_MONTHLY = "price_basic_month";
  process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_premium_month";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_BASIC_MONTHLY;
  delete process.env.STRIPE_PRICE_PREMIUM_MONTHLY;
});

describe("Stripe billing webhooks", () => {
  it("rejects unsigned requests", async () => {
    const res = await app.inject({ method: "POST", url: "/api/billing/webhook", payload: "{}", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
  });

  it("projects signed subscription and invoice events exactly once", async () => {
    const checkout = event("evt_checkout", "checkout.session.completed", { id: "cs_test", client_reference_id: DEMO.tenantId, customer: "cus_test" });
    expect((await send(checkout)).statusCode).toBe(200);

    const subscription = event("evt_subscription", "customer.subscription.updated", {
      id: "sub_test", customer: "cus_test", status: "active", cancel_at_period_end: false,
      current_period_end: 1_800_000_000, metadata: { currencydesk_plan: "pro" },
      items: { data: [{ price: { id: "price_pro_month" } }] },
    });
    expect((await send(subscription)).statusCode).toBe(200);

    const invoice = event("evt_invoice", "invoice.paid", {
      id: "in_test", customer: "cus_test", subscription: "sub_test", status: "paid", currency: "cad",
      amount_due: 49900, amount_paid: 49900, total_tax_amounts: [{ amount: 6487 }],
      hosted_invoice_url: "https://invoice.stripe.test/in_test", invoice_pdf: "https://invoice.stripe.test/in_test.pdf",
    });
    expect((await send(invoice)).statusCode).toBe(200);
    const duplicate = await send(invoice);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);

    const tenant = (await handle.db.select().from(schema.tenants)).find((row) => row.id === DEMO.tenantId);
    expect(tenant?.plan).toBe("pro");
    const invoices = await handle.db.select().from(schema.stripeInvoices);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ stripeInvoiceId: "in_test", tenantId: DEMO.tenantId, amountPaid: 49900, tax: 6487 });
    const events = await handle.db.select().from(schema.stripeEvents);
    expect(events).toHaveLength(3);
    expect(events.every((row) => row.processedAt instanceof Date)).toBe(true);
  });

  it("takes a plan change in the Stripe portal from the price, whichever event arrives first", async () => {
    /* Checkout stamped "basic" in the metadata. The owner then moved to
       AI Bundle in the portal. Stripe invoices a credit for the unused
       basic time and a charge for premium, and here that invoice lands
       before the subscription update. */
    const checkout = event("evt_checkout_upgrade", "checkout.session.completed", { id: "cs_upgrade", client_reference_id: DEMO.tenantId, customer: "cus_upgrade" });
    expect((await send(checkout)).statusCode).toBe(200);

    const upgradeInvoice = event("evt_invoice_upgrade", "invoice.paid", {
      id: "in_upgrade", customer: "cus_upgrade", status: "paid", currency: "usd", amount_due: 0, amount_paid: 0,
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_upgrade" } },
      lines: { data: [
        { amount: -29900, pricing: { price_details: { price: "price_basic_month" } } },
        { amount: 74900, pricing: { price_details: { price: "price_premium_month" } } },
      ] },
    });
    expect((await send(upgradeInvoice)).statusCode).toBe(200);
    let tenant = (await handle.db.select().from(schema.tenants)).find((row) => row.id === DEMO.tenantId);
    expect(tenant?.plan).toBe("premium");

    const updated = event("evt_subscription_upgrade", "customer.subscription.updated", {
      id: "sub_upgrade", customer: "cus_upgrade", status: "active", cancel_at_period_end: false,
      current_period_end: 1_800_000_000, metadata: { currencydesk_plan: "basic" },
      items: { data: [{ price: { id: "price_premium_month" } }] },
    });
    expect((await send(updated)).statusCode).toBe(200);
    const subscription = (await handle.db.select().from(schema.stripeSubscriptions)).find((row) => row.stripeSubscriptionId === "sub_upgrade");
    expect(subscription?.plan).toBe("premium");
    tenant = (await handle.db.select().from(schema.tenants)).find((row) => row.id === DEMO.tenantId);
    expect(tenant?.plan).toBe("premium");
  });

  it("moves the shop to the subscription's plan when Stripe reports it active, and not while an upgrade is unpaid", async () => {
    const checkout = event("evt_checkout_active", "checkout.session.completed", { id: "cs_active", client_reference_id: DEMO.tenantId, customer: "cus_active" });
    expect((await send(checkout)).statusCode).toBe(200);
    const subscription = (id: string, status: string, priceId: string, pendingUpdate: unknown = null) => event(id, "customer.subscription.updated", {
      id: "sub_active", customer: "cus_active", status, cancel_at_period_end: false, current_period_end: 1_800_000_000,
      metadata: { currencydesk_plan: "basic" }, pending_update: pendingUpdate,
      items: { data: [{ price: { id: priceId } }] },
    });
    const plan = async () => (await handle.db.select().from(schema.tenants)).find((row) => row.id === DEMO.tenantId)?.plan;

    expect((await send(subscription("evt_active_basic", "active", "price_basic_month"))).statusCode).toBe(200);
    expect(await plan()).toBe("basic");
    expect((await send(subscription("evt_active_pending", "active", "price_basic_month", { expires_at: 1_800_000_000 }))).statusCode).toBe(200);
    expect(await plan()).toBe("basic");
    expect((await send(subscription("evt_past_due", "past_due", "price_premium_month"))).statusCode).toBe(200);
    expect(await plan()).toBe("basic");
    expect((await send(subscription("evt_active_premium", "active", "price_premium_month"))).statusCode).toBe(200);
    expect(await plan()).toBe("premium");
  });
});
