/* A failed sign-up activation never writes personal data or secret
   hashes to the log (standards §6, sign-up build doc §9.8).

   setup_intent.succeeded opens the desk inside a transaction
   (onboarding/signup-open.ts), so a database failure there reaches the
   Stripe webhook as a DrizzleQueryError. Its message and its params hold
   every bound value, and its cause's detail can repeat one. The values
   below are synthetic stand-ins of the same shape, and the app is the
   production one (buildApp with its real logger options). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const bound = vi.hoisted(() => ({
  cdId: "CD-LOGS-7K42",
  email: "owner@synthetic.example",
  passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljcGFzc3dvcmQ",
  pinHash: "$argon2id$v=19$m=65536,t=3,p=1$c3ludGhldGljcGlu$c3ludGhldGljcGluaGFzaA",
}));

vi.mock("../src/onboarding/signup-open.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/onboarding/signup-open.js")>();
  const { DrizzleQueryError } = await import("drizzle-orm");
  return {
    ...actual,
    openFromSetupIntent: async () => {
      const cause = Object.assign(new Error('duplicate key value violates unique constraint "staff_users_cd_id_unique"'), {
        code: "23505", detail: `Key (cd_id)=(${bound.cdId}) already exists.`,
      });
      throw new DrizzleQueryError(
        'update "staff_users" set "pin_hash" = $1, "cd_id" = $2, "email" = $3, "password_hash" = $4',
        [bound.pinHash, bound.cdId, bound.email, bound.passwordHash], cause,
      );
    },
  };
});

const WEBHOOK_SECRET = "whsec_activation_log_test_only";
let handle: DbHandle;
let app: FastifyInstance;
const lines: string[] = [];
const logged = () => lines.join("");
const rows = () => lines.flatMap((chunk) => chunk.trim().split("\n")).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_activation_log_only";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db, {}, new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } }));
});
afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
  await app.close(); await handle.close();
});

describe("a failed sign-up activation", () => {
  it("logs a bounded reason from the Stripe webhook, never the bound values", async () => {
    lines.length = 0;
    const id = `evt_${randomUUID()}`;
    const payload = JSON.stringify({
      id, object: "event", type: "setup_intent.succeeded", livemode: false,
      data: { object: { id: "seti_activation_log", object: "setup_intent", customer: "cus_activation_log", status: "succeeded", payment_method: "pm_test", metadata: { currencydesk_signup_enquiry: "enq-activation-log", currencydesk_signup_agreement: "agr-activation-log" } } },
    });
    const res = await app.inject({
      method: "POST", url: "/api/billing/webhook", payload,
      headers: { "content-type": "application/json", "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "webhook_processing_failed" });
    // The claim is released, so Stripe's retry processes the event again.
    expect(await handle.db.select().from(schema.stripeEvents).where(eq(schema.stripeEvents.stripeEventId, id))).toHaveLength(0);

    for (const value of Object.values(bound)) expect(logged()).not.toContain(value);
    expect(logged()).not.toContain("Failed query");
    expect(logged()).not.toContain("already exists");
    const failed = rows().filter((row) => row.msg === "Stripe webhook processing failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).not.toHaveProperty("err");
    expect(failed[0]).toMatchObject({ level: 50, reason: "webhook_processing_failed", name: "DrizzleQueryError", sqlState: "23505", stripeEventId: id, stripeEventType: "setup_intent.succeeded" });
  });
});

describe("a database failure on a sign-up route outside /api/onboarding/", () => {
  it("logs and answers a bounded reason on the Early Access form", async () => {
    const applicant = { email: "applicant@synthetic.example", name: "Synthetic Applicant", phone: "+14165550199" };
    // A stand-in for any database failure while the application is written.
    await handle.db.execute(sql.raw("CREATE FUNCTION refuse_enquiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic database failure'; END $$"));
    await handle.db.execute(sql.raw("CREATE TRIGGER refuse_enquiry BEFORE INSERT ON enquiries FOR EACH ROW EXECUTE FUNCTION refuse_enquiry()"));
    try {
      lines.length = 0;
      const res = await app.inject({ method: "POST", url: "/api/enquiries", payload: { kind: "contact", email: applicant.email, name: applicant.name, details: { phone: applicant.phone } } });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "temporarily_unavailable" });
      for (const value of Object.values(applicant)) {
        expect(res.body).not.toContain(value);
        expect(logged()).not.toContain(value);
      }
      expect(logged()).not.toContain("Failed query");
      const failed = rows().filter((row) => row.reason === "database_error");
      expect(failed).toHaveLength(1);
      expect(failed[0]).not.toHaveProperty("err");
      expect(failed[0]).toMatchObject({ level: 50, name: "DrizzleQueryError", sqlState: "P0001", status: 500 });
    } finally {
      await handle.db.execute(sql.raw("DROP TRIGGER refuse_enquiry ON enquiries"));
      await handle.db.execute(sql.raw("DROP FUNCTION refuse_enquiry()"));
    }
  });
});
