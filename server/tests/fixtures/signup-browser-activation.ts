/* Local browser test fixture only. Real provisioning/session; simulated Stripe.
   No HTTP route imports this file and it cannot contact a payment provider. */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb, schema } from "../../src/db/index.js";
import { localTestRuntime } from "../../src/local-test-runtime.js";
import { openFromSetupIntent, startPayment, type SignupStripe } from "../../src/onboarding/signup-open.js";
if (process.env.SIGNUP_BROWSER_FIXTURE !== "1" || process.env.NODE_ENV !== "test" || !process.env.SEAM_DATABASE_URL || !localTestRuntime(process.env)) throw Error("local test fixture only");
process.env.DATABASE_URL = process.env.SEAM_DATABASE_URL;
const [operation, cdId] = process.argv.slice(2);
const h = await createDb();
try {
  const row = (await h.db.select().from(schema.enquiries).where(eq(schema.enquiries.cdId, cdId ?? "")))[0];
  if (!row || !row.email.endsWith("@synthetic.example")) throw Error("synthetic reservation required");
  let result: unknown;
  if (operation === "prepare") {
    const stripe: SignupStripe = { customers: { create: async () => ({ id: "cus_e2e_" + randomUUID() }) }, setupIntents: { create: async () => ({ id: "seti_e2e_" + randomUUID(), client_secret: "synthetic-not-stripe" }) } };
    const prepared = await startPayment(h.db, stripe, row, { plan: "ai", term: "annual", locations: 1, brief: true, call: false, website: false, setupWeek: false }, false);
    result = { setupIntentId: prepared.setupIntentId, termsSourceHash: prepared.termsSourceHash };
  } else if (operation === "activate") {
    const a = (await h.db.select().from(schema.signupAccounts).where(eq(schema.signupAccounts.enquiryId, row.id)))[0];
    if (!a?.setupIntentId?.startsWith("seti_e2e_")) throw Error("fixture intent required");
    result = await openFromSetupIntent(h.db, { id: a.setupIntentId, customer: a.stripeCustomerId, status: "succeeded", paymentMethod: "pm_e2e", metadata: { currencydesk_signup_enquiry: row.id, currencydesk_signup_agreement: String(a.planChoice?.agreement ?? "") } });
  } else if (operation === "tills") {
    if (!row.tenantId) throw Error("tenant absent");
    result = await h.db.execute(sql`SELECT count(*)::int AS n FROM ledger_till_sessions WHERE tenant_id = ${row.tenantId}`);
  } else throw Error("fixture operation unknown");
  console.log("SIGNUP_FIXTURE=" + JSON.stringify(result));
} finally { await h.close(); }
