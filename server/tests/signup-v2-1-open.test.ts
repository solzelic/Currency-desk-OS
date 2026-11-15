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

const WEBHOOK_SECRET = "whsec_signup_test_only";
let handle: DbHandle;
let app: FastifyInstance;
let door: ReturnType<typeof createIdDoor>;
const inbox: { to: string; text: string }[] = [];
const intents: { id: string; customer: string; metadata: Record<string, string> }[] = [];
const fakeStripe: SignupStripe = {
  customers: { create: async () => ({ id: `cus_${randomUUID().slice(0, 8)}` }) },
  setupIntents: {
    create: async (p) => {
      const id = `seti_${randomUUID().slice(0, 12)}`;
      intents.push({ id, customer: p.customer, metadata: p.metadata });
      return { id, client_secret: `${id}_secret_test` };
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
    ["19-idline", { idOver: "1000" }],
    ["20-team", { team: [{ first: "Samira", last: "Haddad", role: "Manager", email: "samira@harbourfx.test" }] }],
  ] as const) expect((await call("PUT", `${base}/answers`, { step, answers })).statusCode).toBe(200);
  const confirm = await call("POST", `${base}/confirm`, { signed: true, name: "Daniel Okafor" });
  expect(confirm.statusCode, confirm.body).toBe(200);
  expect(confirm.json().declaration).toBe("I confirm these details are true, and I'm authorised to open this desk for Harbour Exchange Inc.");
  return { ...r, base };
}
const PLAN = { plan: "ai", term: "monthly", extras: { brief: true, call: true, website: false, setupWeek: false }, agreed: true };

async function stripeSays(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, object: "event", type, livemode: false, data: { object } });
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
    expect(monthlyFor({ plan: "ai", term: "monthly", locations: 1, brief: true, call: true, website: false, setupWeek: false })).toEqual({ perLocation: 750, total: 750, dueToday: 0 });
    expect(monthlyFor({ plan: "ai", term: "annual", locations: 2, brief: true, call: true, website: false, setupWeek: false })).toEqual({ perLocation: 675, total: 1350, dueToday: 0 });
    expect(declarationName("York Foreign Exchange Inc.")).toBe("York Foreign Exchange Inc");
    expect(answersHash({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(answersHash({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});

describe("from the ID to inside, on the server", () => {
  it("opens the desk on Stripe's word and upgrades the enrolment session to a real one", async () => {
    const r = await readyToPay();
    const plan = await call("POST", `${r.base}/plan`, PLAN);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json()).toMatchObject({ ok: true, price: { perLocation: 750, total: 750, dueToday: 0 } });
    expect(plan.json().clientSecret).toMatch(/^seti_.*_secret_test$/);
    /* not open until Stripe says so */
    expect((await call("POST", `${r.base}/open`)).statusCode).toBe(202);
    expect((await loadAccount(handle.db, r.id)).state).toBe("verified");

    const intent = intents.at(-1)!;
    const hook = await stripeSays("setup_intent.succeeded", { id: intent.id, object: "setup_intent", customer: intent.customer, status: "succeeded", metadata: intent.metadata });
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
