/* ============================================================
   Sign-up v2.1, chapter 5: confirm, plan, pay, inside
   (SIGNUP-LOGIC §5, §10; build doc §6 Chapter 5, §9.4, §9.5).

   CONFIRM. The desk record is signed: when, the name as signature, the
   declaration's version, and a SHA-256 of the answers as they stood. Any
   later answer clears it (routes/signup-desk.ts), so the desk that opens
   is the desk that was signed.

   PAY. A Stripe SetupIntent only: the card is kept, nothing is charged,
   due today is $0.00 (§5.3). No money moves here, and none of this
   touches the ledger.

   OPEN. Stripe's `setup_intent.succeeded`, through the existing signed and
   de-duplicated webhook (routes/billing.ts), creates the desk with the
   same provisionDesk the older setup uses, gives the owner the PIN and
   CurrencyDesk ID chosen here, moves verified → active, and records
   signup.completed. A failed card never reaches it: the account stays
   verified and nothing is created.

   INSIDE. The browser that paid asks POST …/open on its enrolment session;
   once the account is active it gets a real desk session and the
   enrolment session is revoked. No second sign-in (§5.4).

   KNOWN GAPS, recorded rather than papered over:
   - a passkey or Google/Microsoft owner gets an unusable random password
     on the staff row; signing in again later needs the Sign-in pack to
     honour signup_credentials (until then the real session is the only
     way in for them);
   - provisionDesk's cross-application slug and owner race is CD-156, a
     go-live blocker this PR does not fix;
   - staff invites by email at opening (§9.1) are not sent yet.
   ============================================================ */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { hashPassword } from "../auth/password.js";
import { fromApplication, resolve, type Answers } from "./flow.js";
import { closeApplication, freeSlug, provisionDesk, specFromAnswers } from "./provision.js";
import { loadOrCreateOnboarding } from "./verify.js";
import { resumable } from "./signup-answers.js";
import { advance } from "./signup-account.js";

export const DECLARATION_VERSION = "v2.1-2026-11-14";

type Enquiry = typeof schema.enquiries.$inferSelect;

/** Order-independent hash of what was signed. */
export function answersHash(answers: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
        : v;
  return createHash("sha256").update(JSON.stringify(canonical(resumable(answers)))).digest("hex");
}

/** The legal name as the declaration names it: no trailing full stop (§5.1). */
export const declarationName = (legal: string): string => legal.trim().replace(/\.+$/, "");

export async function confirmDesk(db: Db, enquiryId: string, signedName: string): Promise<boolean> {
  const row = await loadOrCreateOnboarding(db, enquiryId);
  const done = await db.update(schema.signupAccounts).set({
    confirmedAt: new Date(), confirmedName: signedName, declarationVersion: DECLARATION_VERSION,
    answersHash: answersHash((row.answers ?? {}) as Record<string, unknown>), updatedAt: new Date(),
  }).where(and(eq(schema.signupAccounts.enquiryId, enquiryId), eq(schema.signupAccounts.state, "verified"))).returning();
  if (!done.length) return false;
  await audit(db, {
    tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", action: "signup.confirmed",
    detail: { enquiryId, declaration: DECLARATION_VERSION, answers: done[0]!.answersHash },
  });
  return true;
}

/** Still signed: confirmed, and the answers have not moved since. */
export async function stillConfirmed(db: Db, enquiryId: string): Promise<boolean> {
  const account = (await db.select().from(schema.signupAccounts).where(eq(schema.signupAccounts.enquiryId, enquiryId)).limit(1))[0];
  if (!account?.confirmedAt || !account.answersHash) return false;
  const row = await loadOrCreateOnboarding(db, enquiryId);
  return answersHash((row.answers ?? {}) as Record<string, unknown>) === account.answersHash;
}

/* ---- the plan (§5.3) ------------------------------------------------ */

/* Per location, in the pack's billing currency (CAD), monthly. Annual is
   10% off. Founding pricing and the 3-month credit are hidden (§14 Q9). */
export const SIGNUP_PLANS = { ai: 750, full: 599, rates: 299 } as const;
export type SignupPlan = keyof typeof SIGNUP_PLANS;

export type PlanChoice = {
  plan: SignupPlan; term: "monthly" | "annual"; locations: number;
  brief: boolean; call: boolean; website: boolean; setupWeek: boolean;
};

/** What this choice costs a month, in whole currency units, per the plan screen. Integers only. */
export function monthlyFor(c: PlanChoice): { perLocation: number; total: number; dueToday: 0 } {
  const base = SIGNUP_PLANS[c.plan];
  const perLocation = c.term === "annual" ? Math.round(base * 0.9) : base;
  return { perLocation, total: perLocation * c.locations, dueToday: 0 };
}

/** The slice of Stripe this needs. The real client is passed in; tests pass a fake. */
export type SignupStripe = {
  customers: { create(p: { email: string; name: string; metadata: Record<string, string> }): Promise<{ id: string }> };
  setupIntents: { create(p: { customer: string; usage: "off_session"; automatic_payment_methods: { enabled: true }; metadata: Record<string, string> }): Promise<{ id: string; client_secret: string | null }> };
};

export async function startPayment(db: Db, stripe: SignupStripe, row: Enquiry, choice: PlanChoice): Promise<{ clientSecret: string }> {
  const account = (await db.select().from(schema.signupAccounts).where(eq(schema.signupAccounts.enquiryId, row.id)).limit(1))[0]!;
  const metadata = { currencydesk_signup_enquiry: row.id };
  const shopName = String(((row.details ?? {}) as Record<string, unknown>).shopName ?? row.name ?? "");
  const customerId = account.stripeCustomerId
    ?? (await stripe.customers.create({ email: row.email, name: shopName, metadata })).id;
  const intent = await stripe.setupIntents.create({ customer: customerId, usage: "off_session", automatic_payment_methods: { enabled: true }, metadata });
  if (!intent.client_secret) throw new Error("Stripe returned a SetupIntent without a client secret");
  await db.update(schema.signupAccounts).set({
    stripeCustomerId: customerId, setupIntentId: intent.id, planChoice: choice, updatedAt: new Date(),
  }).where(eq(schema.signupAccounts.enquiryId, row.id));
  /* the plan joins the answers under the design's names, which is where provisioning reads it */
  const ob = await loadOrCreateOnboarding(db, row.id);
  const answers = { ...((ob.answers ?? {}) as Record<string, unknown>), plan: choice.plan, term: choice.term, brief: choice.brief, call: choice.call };
  await db.update(schema.onboarding).set({ answers, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, row.id));
  return { clientSecret: intent.client_secret };
}

/* ---- opening the desk ------------------------------------------------ */

export type OpenResult = { opened: true; tenantId: string } | { opened: false; reason: "unknown_intent" | "not_verified" | "not_confirmed" | "already_open" };

/** Stripe said the card is saved. Create the desk, once. */
export async function openFromSetupIntent(db: Db, intent: { id: string; metadata?: Record<string, string> | null }): Promise<OpenResult> {
  const enquiryId = intent.metadata?.currencydesk_signup_enquiry;
  if (!enquiryId) return { opened: false, reason: "unknown_intent" };
  const account = (await db.select().from(schema.signupAccounts).where(and(
    eq(schema.signupAccounts.enquiryId, enquiryId), eq(schema.signupAccounts.setupIntentId, intent.id),
  )).limit(1))[0];
  if (!account) return { opened: false, reason: "unknown_intent" };
  if (account.state === "active") return { opened: false, reason: "already_open" };
  if (account.state !== "verified") return { opened: false, reason: "not_verified" };
  if (!(await stillConfirmed(db, enquiryId))) return { opened: false, reason: "not_confirmed" };
  const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, enquiryId)).limit(1))[0]!;
  const ob = await loadOrCreateOnboarding(db, enquiryId);
  if (ob.tenantId) {
    await advance(db, enquiryId, "active");
    return { opened: false, reason: "already_open" };
  }

  const resolved = resolve((ob.answers ?? {}) as Answers, fromApplication(row));
  const spec = specFromAnswers(resolved, row);
  spec.email = row.email;
  const d = (row.details ?? {}) as Record<string, unknown>;
  const wanted = (typeof d.workspace === "string" ? d.workspace.split(".")[0] : "") || spec.slug;
  spec.slug = await freeSlug(db, wanted ?? spec.slug, row.email);

  const password = (await db.select().from(schema.signupCredentials).where(and(
    eq(schema.signupCredentials.enquiryId, enquiryId), eq(schema.signupCredentials.kind, "password"), isNotNull(schema.signupCredentials.verifiedAt),
  )).limit(1))[0];
  /* A passkey or SSO owner has no password: theirs is a random one nobody
     holds (see KNOWN GAPS). */
  const passwordHash = password?.passwordHash ?? (await hashPassword(randomBytes(32).toString("base64url")));
  const made = await provisionDesk(db, spec, passwordHash, "signup-v2.1");

  await db.update(schema.staffUsers).set({
    ...(account.pinHash ? { pinHash: account.pinHash, pinSetAt: account.pinSetAt ?? new Date() } : {}),
    ...(row.cdId ? { cdId: row.cdId } : {}),
  }).where(eq(schema.staffUsers.id, made.ownerId));
  if (account.stripeCustomerId) {
    const now = new Date();
    await db.insert(schema.stripeCustomers).values({ tenantId: made.tenantId, stripeCustomerId: account.stripeCustomerId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: schema.stripeCustomers.tenantId, set: { stripeCustomerId: account.stripeCustomerId, updatedAt: now } });
  }
  await db.update(schema.onboarding).set({ tenantId: made.tenantId, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, enquiryId));
  await advance(db, enquiryId, "active");
  await closeApplication(db, { enquiryId, email: row.email }, made.tenantId, "signup-v2.1", spec.setup);
  await audit(db, {
    tenantId: made.tenantId, legalEntityId: made.legalEntityId, branchId: made.branchId, actorId: made.ownerId,
    action: "signup.completed", detail: { enquiryId, plan: account.planChoice ?? null, via: "signup-v2.1" },
  });
  return { opened: true, tenantId: made.tenantId };
}
