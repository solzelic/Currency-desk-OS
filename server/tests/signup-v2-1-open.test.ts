/* Sign-up v2.1, PR 6: confirm, plan, pay, inside (SIGNUP-LOGIC §5, §10;
   build doc §6 Chapter 5, §9.4, §9.5, §10 "payment failure leaves
   verified").

   The whole server path, once: an ID, a password, the email code, the
   PIN, the chapters, the signed declaration, a SetupIntent from a fake
   Stripe (nothing charged), then Stripe's signed setup_intent.succeeded
   through the REAL billing webhook route, then POST /open turning the
   enrolment session into a real desk session. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rawBody from "fastify-raw-body";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { registerCredentialRoutes } from "../src/routes/signup-credential.js";
import { registerSignupEmailRoutes } from "../src/routes/signup-email.js";
import { registerSignupDeskRoutes } from "../src/routes/signup-desk.js";
import { registerBillingRoutes } from "../src/routes/billing.js";
import { loadAccount } from "../src/onboarding/signup-account.js";
import { answersHash, declarationName, monthlyFor, openFromSetupIntent, type SignupStripe } from "../src/onboarding/signup-open.js";
import { resolveSession } from "../src/auth/sessions.js";
import { verifyPassword } from "../src/auth/password.js";
import { moveTo } from "../src/onboarding/pipeline.js";

const WEBHOOK_SECRET = "whsec_signup_test_only";
let handle: DbHandle;
let app: FastifyInstance;
let door: ReturnType<typeof createIdDoor>;
const inbox: { to: string; text: string }[] = [];
const intents: { id: string; customer: string; metadata: Record<string, string> }[] = [];
const intentKeys = new Map<string, { id: string; client_secret: string }>();
const fakeStripe: SignupStripe = {
  customers: { create: async () => ({ id: `cus_${randomUUID().slice(0, 8)}` }) },
  setupIntents: {
    create: async (p, options?: { idempotencyKey: string }) => {
      const previous = options && intentKeys.get(options.idempotencyKey);
      if (previous) return previous;
      const id = `seti_${randomUUID().slice(0, 12)}`;
      intents.push({ id, customer: p.customer, metadata: p.metadata });
      const result = { id, client_secret: `${id}_secret_test` };
      if (options) intentKeys.set(options.idempotencyKey, result);
      return result;
    },
  },
};

let n = 0;
async function reserve() {
  n++;
  const id = `enq-${randomUUID()}`;
  const A = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const cdId = `CD-OPEN-${A[n % 31]}${A[(n * 3) % 31]}${A[(n * 5) % 31]}${A[(n * 7) % 31]}`;
  const email = `open${n}@harbourfx.test`;
  await handle.db.insert(schema.enquiries).values({
    id, reference: `CD-O${String(n).padStart(5, "0")}`, kind: "early_access", email, name: "Daniel Okafor", status: "invited", cdId,
    details: { firstName: "Daniel", lastName: "Okafor", shopName: `Harbour Exchange ${n}`, jurisdiction: "CA", province: "ON", workspace: `harbour-${n}.currencydeskos.com`, phone: "+1 416 555 0142" },
  });
  return { id, cdId, email };
}
const jar: Record<string, string> = {};
const keep = <T extends { cookies: { name: string; value: string }[] }>(res: T): T => { for (const c of res.cookies) jar[c.name] = c.value; return res; };
const call = async (method: "POST" | "PUT" | "GET", url: string, payload?: unknown) =>
  keep(await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), cookies: { ...jar } }));

/* Everything up to and including the signed declaration. */
async function readyToPay() {
  for (const k of Object.keys(jar)) delete jar[k];
  const r = await reserve();
  const base = `/api/onboarding/${r.cdId}`;
  expect((await call("POST", `${base}/password`, { password: "four plain words here", confirm: "four plain words here" })).statusCode).toBe(200);
  const code = [...inbox].reverse().find((m) => m.to === r.email)!.text.match(/\b(\d{6})\b/)![1];
  expect((await call("POST", `${base}/email/verify`, { code })).statusCode).toBe(200);
  expect((await call("POST", `${base}/pin`, { pin: "4821", confirm: "4821" })).statusCode).toBe(200);
  for (const [step, answers] of [
    ["08-shop-name", { operatingName: `Harbour Exchange ${n}`, bizName: "Harbour Exchange Inc." }],
    ["09-address", { street: "1420 Dundas St W", city: "Toronto", region: "ON", postal: "M6J 1Y5", addrManual: true }],
    ["14-currencies", { currencies: ["USD", "EUR"] }],
    ["18-officer", { complianceMode: "me" }],
    ["19-idline", { idOver: "1000" }],
    ["20-team", { team: [{ first: "Samira", last: "Haddad", role: "Manager", email: "samira@harbourfx.test" }] }],
  ] as const) expect((await call("PUT", `${base}/answers`, { step, answers })).statusCode).toBe(200);
  const confirm = await call("POST", `${base}/confirm`, { signed: true, name: "Daniel Okafor" });
  expect(confirm.statusCode, confirm.body).toBe(200);
  expect(confirm.json().declaration).toBe("I confirm these details are true, and I'm authorised to open this desk for Harbour Exchange Inc.");
  return { ...r, base };
}
const PLAN = { plan: "ai", term: "monthly", extras: { brief: true, call: true, website: false, setupWeek: false }, agreed: true };

/* A fresh event each time unless `eventId` is given. A resend from the
   Stripe dashboard or CLI carries the original event's id, so tests of a
   resend must pass the same one. */
async function stripeSays(type: string, object: Record<string, unknown>, eventId = `evt_${randomUUID()}`) {
  const payload = JSON.stringify({ id: eventId, object: "event", type, livemode: false, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return app.inject({ method: "POST", url: "/api/billing/webhook", payload, headers: { "content-type": "application/json", "stripe-signature": signature } });
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_signup_only";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  app = Fastify();
  await app.register(cookie);
  await app.register(rawBody, { global: false, encoding: false, runFirst: true });
  door = createIdDoor({ db: handle.db, logRefusal: () => {} });
  const mail = async (to: string, _s: string, body: { text: string }) => { inbox.push({ to, text: body.text }); return "simulated" as const; };
  registerCredentialRoutes(app, handle.db, door, { breachRange: async () => "00000000000000000000000000000000000:0", mail });
  registerSignupEmailRoutes(app, handle.db, door, { mail });
  registerSignupDeskRoutes(app, handle.db, door, { stripe: () => fakeStripe });
  registerBillingRoutes(app, handle.db);
  await app.ready();
});
afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
  await app.close(); await handle.close();
});
beforeEach(() => door.reset());

describe("the plan screen's arithmetic", () => {
  it("is per location, integers, annual 10% off, $0 today", () => {
    expect(monthlyFor({ plan: "ai", term: "monthly", locations: 1, brief: true, call: true, website: false, setupWeek: false })).toEqual({ currency: "CAD", perLocationMinor: 75000, totalMinor: 75000, dueTodayMinor: 0, setupWeekMinor: 0 });
    expect(monthlyFor({ plan: "ai", term: "annual", locations: 2, brief: true, call: true, website: false, setupWeek: false })).toEqual({ currency: "CAD", perLocationMinor: 67500, totalMinor: 135000, dueTodayMinor: 0, setupWeekMinor: 0 });
    expect(declarationName("York Foreign Exchange Inc.")).toBe("York Foreign Exchange Inc");
    expect(answersHash({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(answersHash({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});

describe("from the ID to inside, on the server", () => {
  it("opens the desk on Stripe's word and upgrades the enrolment session to a real one", async () => {
    const r = await readyToPay();
    const plan = await call("POST", `${r.base}/plan`, PLAN);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json()).toMatchObject({ ok: true, price: { currency: "CAD", perLocationMinor: 75000, totalMinor: 75000, dueTodayMinor: 0, setupWeekMinor: 0 } });
    expect(plan.json().clientSecret).toMatch(/^seti_.*_secret_test$/);
    /* not open until Stripe says so */
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(202);
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");

    const intent = intents.at(-1)!;
    const hook = await stripeSays("setup_intent.succeeded", { id: intent.id, object: "setup_intent", customer: intent.customer, status: "succeeded", payment_method: "pm_test", metadata: intent.metadata });
    expect(hook.statusCode, hook.body).toBe(200);
    expect((await loadAccount(handle.db, r.id)).state).toBe("active");

    const opened = await call("POST", `${r.base}/open`);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({ ok: true, cdId: r.cdId, operatingName: expect.stringContaining("Harbour Exchange") });
    const session = await resolveSession(handle.db, jar.cdos_session);
    expect(session?.staffId).toBe(r.email);
    const owner = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, session!.id)))[0]!;
    expect(owner.cdId).toBe(r.cdId);
    expect(await verifyPassword("4821", owner.pinHash!)).toBe(true);
    expect(await verifyPassword("four plain words here", owner.passwordHash)).toBe(true);
    const tenantId = opened.json().tenantId as string;
    expect((await handle.db.select().from(schema.stripeCustomers).where(eq(schema.stripeCustomers.tenantId, tenantId)))[0]?.stripeCustomerId).toBe(intent.customer);
    /* the enrolment session is spent */
    expect((await handle.db.select().from(schema.enrolmentSessions).where(eq(schema.enrolmentSessions.enquiryId, r.id))).every((s) => s.revokedAt)).toBe(true);
    const done = (await handle.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, tenantId), eq(schema.auditEvents.action, "signup.completed"))));
    expect(done).toHaveLength(1);
    /* a replayed Stripe event does not open a second desk */
    expect((await openFromSetupIntent(handle.db, { id: intent.id, metadata: intent.metadata })).opened).toBe(false);
  });

  it("a card that fails leaves the account verified and creates nothing", async () => {
    const r = await readyToPay();
    expect((await call("POST", `${r.base}/plan`, PLAN)).statusCode).toBe(200);
    const intent = intents.at(-1)!;
    expect((await stripeSays("setup_intent.setup_failed", { id: intent.id, object: "setup_intent", customer: intent.customer, status: "requires_payment_method", metadata: intent.metadata })).statusCode).toBe(200);
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");
    expect((await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, r.id)))[0]!.tenantId).toBeNull();
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(202);
  });

  it("an answer changed after signing must be signed again", async () => {
    const r = await readyToPay();
    await call("PUT", `${r.base}/answers`, { step: "14-currencies", answers: { currencies: ["USD"] } });
    expect((await call("POST", `${r.base}/plan`, PLAN)).json().error).toBe("not_confirmed");
  });

  it("refuses the plan without the agreement, and 503s when Stripe is not configured", async () => {
    const r = await readyToPay();
    expect((await call("POST", `${r.base}/plan`, { ...PLAN, agreed: false })).statusCode).toBe(400);
    const bare = Fastify();
    await bare.register(cookie);
    registerSignupDeskRoutes(bare, handle.db, door, { stripe: () => null });
    const res = await bare.inject({ method: "POST", url: `${r.base}/plan`, payload: PLAN, cookies: { ...jar } });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });

  it("ignores a SetupIntent the sign-up did not make", async () => {
    expect((await openFromSetupIntent(handle.db, { id: "seti_stranger", metadata: { currencydesk_signup_enquiry: "enq-none" } })).opened).toBe(false);
    expect((await stripeSays("setup_intent.succeeded", { id: "seti_other", object: "setup_intent", metadata: {} })).statusCode).toBe(200);
  });
});

describe("activation consistency regressions", () => {
  it("annual Full pricing preserves the ten-cent fraction in integer minor units", () => {
    expect(monthlyFor({ plan: "full", term: "annual", locations: 2, brief: false, call: false, website: false, setupWeek: true })).toMatchObject({ currency: "CAD", perLocationMinor: 53910, totalMinor: 107820, dueTodayMinor: 0, setupWeekMinor: 500000 });
  });
  it("retrying an unchanged plan returns the same intent", async () => {
    const r = await readyToPay();
    const first = await call("POST", `${r.base}/plan`, PLAN);
    const retry = await call("POST", `${r.base}/plan`, PLAN);
    expect(retry.json().clientSecret).toBe(first.json().clientSecret);
  });
  it("editing and signing again cannot activate the old payment agreement", async () => {
    const r = await readyToPay();
    await call("POST", `${r.base}/plan`, PLAN);
    const intent = intents.at(-1)!;
    await call("PUT", `${r.base}/answers`, { step: "14-currencies", answers: { currencies: ["EUR"] } });
    await call("POST", `${r.base}/confirm`, { signed: true, name: "Daniel Okafor" });
    await stripeSays("setup_intent.succeeded", { ...intent, status: "succeeded", payment_method: "pm_test" });
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");
  });
  it("rejects a signed webhook with the wrong customer", async () => {
    const r = await readyToPay();
    await call("POST", `${r.base}/plan`, PLAN);
    const intent = intents.at(-1)!;
    await stripeSays("setup_intent.succeeded", { ...intent, customer: "cus_wrong", status: "succeeded", payment_method: "pm_test" });
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");
  });
  it("SAM opt-out uses the existing stop record even when card processing is unavailable", async () => {
    const r = await readyToPay();
    const bare = Fastify();
    await bare.register(cookie);
    registerSignupDeskRoutes(bare, handle.db, door, { stripe: () => null });
    const res = await bare.inject({ method: "POST", url: `${r.base}/plan`, cookies: { ...jar }, payload: { ...PLAN, extras: { ...PLAN.extras, call: false } } });
    expect(res.statusCode).toBe(503);
    expect((await handle.db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, r.id)))[0]?.event).toBe("stop");
    await bare.close();
  });

  it("concurrent browser upgrades consume the enrolment session once", async () => {
    const r = await readyToPay();
    await call("POST", `${r.base}/plan`, PLAN);
    const intent = intents.at(-1)!;
    await stripeSays("setup_intent.succeeded", { ...intent, status: "succeeded", payment_method: "pm_test" });
    const cookies = { ...jar };
    const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: "POST", url: `${r.base}/open`, cookies })));
    expect(results.filter(response => response.statusCode === 200)).toHaveLength(1);
    expect(results.filter(response => response.cookies.some(c => c.name === "cdos_session"))).toHaveLength(1);
  });

  it("the server prices the saved three-location shop count and refuses a client quantity", async () => {
    const r = await readyToPay();
    await call("PUT", `${r.base}/answers`, { step: "11-shops-more", answers: { shops: "more", shopCount: 3 } });
    await call("POST", `${r.base}/confirm`, { signed: true, name: "Daniel Okafor" });
    expect((await call("POST", `${r.base}/plan`, { ...PLAN, locations: 99 })).statusCode).toBe(400);
    const response = await call("POST", `${r.base}/plan`, { ...PLAN, plan: "full", term: "annual" });
    expect(response.json().price).toMatchObject({ currency: "CAD", totalMinor: 161730, dueTodayMinor: 0 });
    expect((await loadAccount(handle.db, r.id)).planChoice?.locations).toBe(3);
  });
  it("an unsupported billing country and an unnamed officer refuse without opening", async () => {
    const r = await readyToPay();
    await call("PUT", `${r.base}/answers`, { step: "18-officer", answers: { complianceMode: "else", compName: "" } });
    expect((await call("POST", `${r.base}/confirm`, { signed: true, name: "Daniel Okafor" })).json().error).toBe("desk_incomplete");
    await call("PUT", `${r.base}/answers`, { step: "18-officer", answers: { complianceMode: "me" } });
    await call("POST", `${r.base}/confirm`, { signed: true, name: "Daniel Okafor" });
    await handle.db.update(schema.enquiries).set({ details: { jurisdiction: "GB" } }).where(eq(schema.enquiries.id, r.id));
    expect((await call("POST", `${r.base}/plan`, PLAN)).json().error).toBe("billing_country_unavailable");
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");
  });

});

/* Support's decision is the gate, not the page. A declined or held owner
   whose browser already holds the SetupIntent's client secret can still
   confirm it with Stripe.js; Stripe's signed yes must not open the desk. */
describe("only an invited application opens its desk", () => {
  const enquiry = async (id: string) => (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, id)))[0]!;
  const succeeded = (intent: (typeof intents)[number]) => ({ id: intent.id, object: "setup_intent", customer: intent.customer, status: "succeeded", payment_method: "pm_test", metadata: intent.metadata });
  async function paidFor() {
    const r = await readyToPay();
    expect((await call("POST", `${r.base}/plan`, PLAN)).statusCode).toBe(200);
    return { ...r, intent: intents.at(-1)! };
  }

  it.each(["declined", "hold"] as const)("a card saved after the application is %s opens nothing, and Stripe is not asked to retry", async (to) => {
    const r = await paidFor();
    const before = await loadAccount(handle.db, r.id);
    expect((await moveTo(handle.db, await enquiry(r.id), to, "support")).ok).toBe(true);
    /* the delivery and a resend of that same event are both acknowledged
       and both refused: a refusal keeps no claim on the event id */
    const eventId = `evt_${randomUUID()}`;
    for (let i = 0; i < 2; i++) {
      const hook = await stripeSays("setup_intent.succeeded", succeeded(r.intent), eventId);
      expect([hook.statusCode, hook.json()]).toEqual([200, { received: true }]);
    }
    expect(await handle.db.select().from(schema.stripeEvents).where(eq(schema.stripeEvents.objectId, r.intent.id))).toEqual([]);
    expect(await openFromSetupIntent(handle.db, { id: r.intent.id, metadata: r.intent.metadata, customer: r.intent.customer, status: "succeeded", paymentMethod: "pm_test" }))
      .toEqual({ opened: false, reason: "not_invited" });
    /* the account is as it was, the decision stands, and no desk exists */
    expect(await loadAccount(handle.db, r.id)).toEqual(before);
    expect(await enquiry(r.id)).toMatchObject({ status: to, tenantId: null, decidedBy: "support" });
    expect((await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, r.id)))[0]!.tenantId).toBeNull();
    expect(await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.cdId, r.cdId))).toHaveLength(0);
    const refused = (await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "signup.open_refused")))
      .filter((e) => (e.detail as { enquiryId?: string }).enquiryId === r.id);
    expect(refused.map((e) => e.detail)).toEqual(Array(3).fill({ enquiryId: r.id, reason: "not_invited", status: to }));
    /* the browser that paid gets no desk session */
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(404);
    expect(jar.cdos_session).toBeUndefined();
  });

  /* Stripe sends one setup_intent.succeeded per intent, and POST /plan
     hands back that same, already succeeded intent. So the only way in
     after a refusal is support resending the very event Stripe sent. */
  it.each(["hold", "reviewing"] as const)("an application moved to %s and invited again opens when support resends the refused event", async (to) => {
    const r = await paidFor();
    const eventId = `evt_${randomUUID()}`;
    expect((await moveTo(handle.db, await enquiry(r.id), to, "support", { quiet: true })).ok).toBe(true);
    const refused = await stripeSays("setup_intent.succeeded", succeeded(r.intent), eventId);
    expect([refused.statusCode, refused.json()]).toEqual([200, { received: true }]);
    expect((await moveTo(handle.db, await enquiry(r.id), "invited", "support", { quiet: true })).ok).toBe(true);
    const resent = await stripeSays("setup_intent.succeeded", succeeded(r.intent), eventId);
    expect([resent.statusCode, resent.json()]).toEqual([200, { received: true }]);
    const opened = await enquiry(r.id);
    expect(opened).toMatchObject({ status: "accepted", decidedBy: "signup-v2.1" });
    expect((await loadAccount(handle.db, r.id)).state).toBe("active");
    /* the opening keeps its claim, so a further resend is only a duplicate */
    expect((await handle.db.select().from(schema.stripeEvents).where(eq(schema.stripeEvents.stripeEventId, eventId)))[0])
      .toMatchObject({ tenantId: opened.tenantId, processedAt: expect.any(Date) });
    expect((await stripeSays("setup_intent.succeeded", succeeded(r.intent), eventId)).json()).toEqual({ received: true, duplicate: true });
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(200);
  });

  it.each([["without its ID", { cdId: null }], ["that is not an early access application", { kind: "signup" as const }]])("an application %s opens nothing", async (_label, change) => {
    const r = await paidFor();
    await handle.db.update(schema.enquiries).set(change).where(eq(schema.enquiries.id, r.id));
    expect((await stripeSays("setup_intent.succeeded", succeeded(r.intent))).statusCode).toBe(200);
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");
    expect((await enquiry(r.id)).status).toBe("invited");
  });

  it("the desk session needs the application this activation accepted", async () => {
    const r = await paidFor();
    expect((await stripeSays("setup_intent.succeeded", succeeded(r.intent))).statusCode).toBe(200);
    const opened = await enquiry(r.id);
    expect(opened.status).toBe("accepted");
    /* a funnel record that does not say this desk opened gives no session */
    await handle.db.update(schema.enquiries).set({ status: "invited" }).where(eq(schema.enquiries.id, r.id));
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(202);
    await handle.db.update(schema.enquiries).set({ status: "accepted", tenantId: "tnt-someone-else" }).where(eq(schema.enquiries.id, r.id));
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(202);
    expect(jar.cdos_session).toBeUndefined();
    await handle.db.update(schema.enquiries).set({ tenantId: opened.tenantId }).where(eq(schema.enquiries.id, r.id));
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(200);
  });

  it("a decision taken on a stale read cannot overwrite a desk that opened meanwhile", async () => {
    const r = await paidFor();
    const seen = await enquiry(r.id);
    expect((await stripeSays("setup_intent.succeeded", succeeded(r.intent))).statusCode).toBe(200);
    expect(await moveTo(handle.db, seen, "declined", "support")).toMatchObject({ ok: false, error: "changed" });
    expect(await enquiry(r.id)).toMatchObject({ status: "accepted", decidedBy: "signup-v2.1" });
  });
});
