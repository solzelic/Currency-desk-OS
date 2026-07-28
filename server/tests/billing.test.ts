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
});
