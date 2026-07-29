/* Stripe Billing boundary.
   Checkout and the customer portal are hosted by Stripe. This server never
   receives PAN/CVC data. Webhooks are signed, deduplicated, and projected into
   small local tables so API entitlements and invoice links remain durable. */
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { TENANT_PLANS, type TenantPlan } from "../db/schema.js";
import { configuredPrice, planForPrice, safeAppBaseUrl, stripeBillingConfig, stripeClient, type BillingCycle, type StripeBillingConfig } from "../billing/stripe.js";

const checkoutBody = z.object({
  plan: z.enum(["basic", "pro", "premium"]),
  cycle: z.enum(["monthly", "annual"]),
  idempotencyKey: z.string().uuid(),
});

type StripeObject = Record<string, unknown>;
const object = (value: unknown): StripeObject => typeof value === "object" && value !== null ? value as StripeObject : {};
const string = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const bool = (value: unknown): boolean => value === true;
const unixDate = (value: unknown): Date | null => typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
const plan = (value: unknown): TenantPlan | null => typeof value === "string" && (TENANT_PLANS as readonly string[]).includes(value) ? value as TenantPlan : null;

function subscriptionId(invoice: StripeObject): string | null {
  const direct = string(invoice.subscription);
  if (direct) return direct;
  const parent = object(invoice.parent);
  return string(object(parent.subscription_details).subscription);
}

function subscriptionPrice(subscription: StripeObject): string | null {
  const items = object(subscription.items).data;
  if (!Array.isArray(items)) return null;
  return string(object(object(items[0]).price).id);
}

async function tenantForCustomer(db: Db, stripeCustomerId: string | null): Promise<string | null> {
  if (!stripeCustomerId) return null;
  const rows = await db.select({ tenantId: schema.stripeCustomers.tenantId }).from(schema.stripeCustomers)
    .where(eq(schema.stripeCustomers.stripeCustomerId, stripeCustomerId)).limit(1);
  return rows[0]?.tenantId ?? null;
}

async function ensureStripeCustomer(db: Db, config: StripeBillingConfig, tenantId: string, email: string | null, name: string): Promise<string> {
  const existing = await db.select().from(schema.stripeCustomers).where(eq(schema.stripeCustomers.tenantId, tenantId)).limit(1);
  if (existing[0]) return existing[0].stripeCustomerId;
  /* Lifetime offers are issued as customer-restricted Stripe promotion codes.
     Before creating a new customer, reuse a reserved customer for the same
     owner email and record the tenant mapping. This keeps the offer locked to
     its intended account instead of relying on a browser-visible code. */
  if (email) {
    const matches = await stripeClient(config).customers.list({ email, limit: 10 });
    const reserved = matches.data.find((customer) => customer.metadata.currencydesk_entitlement === "lifetime_owner" || customer.metadata.currencydesk_entitlement === "lifetime_guest");
    if (reserved) {
      const now = new Date();
      await db.insert(schema.stripeCustomers).values({ tenantId, stripeCustomerId: reserved.id, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: schema.stripeCustomers.tenantId, set: { stripeCustomerId: reserved.id, updatedAt: now } });
      return reserved.id;
    }
  }
  const customer = await stripeClient(config).customers.create({ email: email ?? undefined, name, metadata: { currencydesk_tenant_id: tenantId } }, { idempotencyKey: `currencydesk:customer:${tenantId}` });
  const now = new Date();
  await db.insert(schema.stripeCustomers).values({ tenantId, stripeCustomerId: customer.id, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.stripeCustomers.tenantId, set: { updatedAt: now } });
  const stored = await db.select().from(schema.stripeCustomers).where(eq(schema.stripeCustomers.tenantId, tenantId)).limit(1);
  return stored[0]?.stripeCustomerId ?? customer.id;
}

async function upsertSubscription(db: Db, config: StripeBillingConfig, tenantId: string, data: StripeObject) {
  const id = string(data.id);
  const customerId = string(data.customer);
  if (!id || !customerId) return;
  const metadata = object(data.metadata);
  const priceId = subscriptionPrice(data);
  const selectedPlan = plan(metadata.currencydesk_plan) ?? planForPrice(config, priceId);
  const now = new Date();
  await db.insert(schema.stripeSubscriptions).values({
    stripeSubscriptionId: id, tenantId, stripeCustomerId: customerId, priceId, plan: selectedPlan,
    status: string(data.status) ?? "unknown", cancelAtPeriodEnd: bool(data.cancel_at_period_end),
    currentPeriodEnd: unixDate(data.current_period_end), createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: schema.stripeSubscriptions.stripeSubscriptionId,
    set: { tenantId, stripeCustomerId: customerId, priceId, plan: selectedPlan, status: string(data.status) ?? "unknown", cancelAtPeriodEnd: bool(data.cancel_at_period_end), currentPeriodEnd: unixDate(data.current_period_end), updatedAt: now },
  });
}

async function upsertInvoice(db: Db, tenantId: string, data: StripeObject) {
  const id = string(data.id);
  const customerId = string(data.customer);
  if (!id || !customerId) return;
  const now = new Date();
  const tax = Array.isArray(data.total_tax_amounts) ? data.total_tax_amounts.reduce<number>((total, item) => total + (integer(object(item).amount) ?? 0), 0) : null;
  await db.insert(schema.stripeInvoices).values({
    stripeInvoiceId: id, tenantId, stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId(data),
    status: string(data.status), currency: string(data.currency), amountDue: integer(data.amount_due), amountPaid: integer(data.amount_paid), tax,
    hostedInvoiceUrl: string(data.hosted_invoice_url), invoicePdf: string(data.invoice_pdf), createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: schema.stripeInvoices.stripeInvoiceId,
    set: { tenantId, stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId(data), status: string(data.status), currency: string(data.currency), amountDue: integer(data.amount_due), amountPaid: integer(data.amount_paid), tax, hostedInvoiceUrl: string(data.hosted_invoice_url), invoicePdf: string(data.invoice_pdf), updatedAt: now },
  });
}

async function applyEvent(db: Db, config: StripeBillingConfig, event: StripeObject): Promise<string | null> {
  const type = string(event.type) ?? "";
  const data = object(object(event.data).object);
  if (type === "checkout.session.completed") {
    const tenantId = string(data.client_reference_id) ?? string(object(data.metadata).currencydesk_tenant_id);
    const customerId = string(data.customer);
    if (!tenantId || !customerId) return null;
    const now = new Date();
    await db.insert(schema.stripeCustomers).values({ tenantId, stripeCustomerId: customerId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: schema.stripeCustomers.tenantId, set: { stripeCustomerId: customerId, updatedAt: now } });
    return tenantId;
  }
  const customerId = string(data.customer);
  const tenantId = await tenantForCustomer(db, customerId);
  if (!tenantId) return null; // a Stripe event for another product/account customer
  if (type.startsWith("customer.subscription.")) await upsertSubscription(db, config, tenantId, data);
  if (type.startsWith("invoice.")) {
    await upsertInvoice(db, tenantId, data);
    if (type === "invoice.paid") {
      const subscription = subscriptionId(data);
      if (subscription) {
        const rows = await db.select({ plan: schema.stripeSubscriptions.plan }).from(schema.stripeSubscriptions)
          .where(and(eq(schema.stripeSubscriptions.stripeSubscriptionId, subscription), eq(schema.stripeSubscriptions.tenantId, tenantId))).limit(1);
        if (rows[0]?.plan) await db.update(schema.tenants).set({ plan: rows[0].plan }).where(eq(schema.tenants.id, tenantId));
      }
    }
  }
  return tenantId;
}

export async function reportKycUsage(db: Db, tenantId: string, verificationId: string): Promise<void> {
  const config = stripeBillingConfig();
  if (!config?.kycMeterEventName) throw new Error("Stripe KYC meter is not configured.");
  const customer = await db.select().from(schema.stripeCustomers).where(eq(schema.stripeCustomers.tenantId, tenantId)).limit(1);
  if (!customer[0]) throw new Error("Tenant has no Stripe customer.");
  await stripeClient(config).billing.meterEvents.create({
    event_name: config.kycMeterEventName,
    payload: { stripe_customer_id: customer[0].stripeCustomerId, value: "1", verification_id: verificationId },
    identifier: `currencydesk:kyc:${verificationId}`,
  });
}

export function registerBillingRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/billing", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const subscription = await db.select().from(schema.stripeSubscriptions).where(eq(schema.stripeSubscriptions.tenantId, who.tenantId)).orderBy(desc(schema.stripeSubscriptions.updatedAt)).limit(1);
    const invoices = await db.select().from(schema.stripeInvoices).where(eq(schema.stripeInvoices.tenantId, who.tenantId)).orderBy(desc(schema.stripeInvoices.updatedAt)).limit(12);
    return { billing: { configured: !!stripeBillingConfig(), subscription: subscription[0] ?? null, invoices } };
  });

  app.post("/api/billing/checkout", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (who.role !== "administrator") return reply.code(403).send({ error: "forbidden" });
    const parsed = checkoutBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const config = stripeBillingConfig();
    if (!config) return reply.code(503).send({ error: "billing_not_configured" });
    const baseUrl = safeAppBaseUrl(config, req.headers.host);
    const price = configuredPrice(config, parsed.data.plan, parsed.data.cycle);
    if (!baseUrl || !price) return reply.code(503).send({ error: "billing_not_configured" });
    const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.id, who.tenantId)).limit(1);
    if (!tenant[0]) return reply.code(404).send({ error: "not_found" });
    const admins = await db.select({ staffId: schema.staffUsers.staffId }).from(schema.staffUsers)
      .where(and(eq(schema.staffUsers.tenantId, who.tenantId), eq(schema.staffUsers.role, "administrator")));
    const email = admins.map((a) => a.staffId).find((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) ?? null;
    const customerId = await ensureStripeCustomer(db, config, who.tenantId, email, tenant[0].name);
    const session = await stripeClient(config).checkout.sessions.create({
      mode: "subscription", customer: customerId, client_reference_id: who.tenantId,
      line_items: [{ price, quantity: 1 }], automatic_tax: { enabled: true }, tax_id_collection: { enabled: true },
      /* Founding offers can make the first three invoices $0. Stripe must
         still collect a card now so normal monthly billing can start in month
         four. Annual billing deliberately has no promo field: a repeating
         three-month coupon would otherwise discount a full annual invoice. */
      payment_method_collection: "always", allow_promotion_codes: parsed.data.cycle === "monthly",
      billing_address_collection: "required", customer_update: { address: "auto", name: "auto" },
      metadata: { currencydesk_tenant_id: who.tenantId, currencydesk_plan: parsed.data.plan, currencydesk_cycle: parsed.data.cycle },
      subscription_data: { metadata: { currencydesk_tenant_id: who.tenantId, currencydesk_plan: parsed.data.plan, currencydesk_cycle: parsed.data.cycle } },
      success_url: `${baseUrl}/app?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/app?billing=cancelled`,
    }, { idempotencyKey: `currencydesk:checkout:${who.tenantId}:${parsed.data.idempotencyKey}` });
    if (!session.url) return reply.code(502).send({ error: "checkout_unavailable" });
    await audit(db, { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id, action: "billing.checkout_started", detail: { plan: parsed.data.plan, cycle: parsed.data.cycle, sessionId: session.id } });
    return { url: session.url };
  });

  app.post("/api/billing/portal", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (who.role !== "administrator") return reply.code(403).send({ error: "forbidden" });
    const config = stripeBillingConfig();
    const baseUrl = config && safeAppBaseUrl(config, req.headers.host);
    if (!config || !baseUrl) return reply.code(503).send({ error: "billing_not_configured" });
    const customer = await db.select().from(schema.stripeCustomers).where(eq(schema.stripeCustomers.tenantId, who.tenantId)).limit(1);
    if (!customer[0]) return reply.code(409).send({ error: "no_billing_customer" });
    const portal = await stripeClient(config).billingPortal.sessions.create({ customer: customer[0].stripeCustomerId, return_url: `${baseUrl}/app` });
    return { url: portal.url };
  });

  app.post("/api/billing/webhook", { config: { rawBody: true } }, async (req, reply) => {
    const config = stripeBillingConfig();
    const signature = req.headers["stripe-signature"];
    if (!config?.webhookSecret || typeof signature !== "string" || !req.rawBody) return reply.code(400).send({ error: "invalid_webhook" });
    let event: StripeObject;
    try { event = object(stripeClient(config).webhooks.constructEvent(req.rawBody, signature, config.webhookSecret)); }
    catch { return reply.code(400).send({ error: "invalid_signature" }); }
    const id = string(event.id);
    const type = string(event.type);
    if (!id || !type) return reply.code(400).send({ error: "invalid_webhook" });
    const data = object(object(event.data).object);
    const claimed = await db.insert(schema.stripeEvents).values({ stripeEventId: id, type, objectId: string(data.id), livemode: bool(event.livemode) })
      .onConflictDoNothing().returning();
    if (!claimed.length) return { received: true, duplicate: true };
    try {
      const tenantId = await applyEvent(db, config, event);
      await db.update(schema.stripeEvents).set({ tenantId, processedAt: new Date() }).where(eq(schema.stripeEvents.stripeEventId, id));
      return { received: true };
    } catch (error) {
      await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.stripeEventId, id));
      req.log.error({ err: error, stripeEventId: id, stripeEventType: type }, "Stripe webhook processing failed");
      return reply.code(500).send({ error: "webhook_processing_failed" });
    }
  });
}
