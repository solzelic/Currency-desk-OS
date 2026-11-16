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
   - CD-156 remains a system-wide provisioning dependency; this path
     refuses tenant collisions transactionally.
   - staff invites by email at opening (§9.1) are not sent yet.
   ============================================================ */
import { z } from "zod";
import { isStagingRuntime } from "../auth/staging-runtime.js";
import { stagingOnboardingMark } from "../routes/staging-fresh-shop.js";
import { packForCountry } from "../ledger/jurisdiction.js";
import { signupPack } from "./signup-pack.js";
import { signupCallPreference } from "./signup-preferences.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { hashPassword } from "../auth/password.js";
import { fromApplication, resolve } from "./flow.js";
import { freeSlug, provisionDesk, specFromAnswers } from "./provision.js";
import { loadOrCreateOnboarding } from "./verify.js";
import { resumable, STEP_FIELDS } from "./signup-answers.js";
import { advance, withSignupAccount } from "./signup-account.js";

export const DECLARATION_VERSION = "v2.1-2026-11-14";
// Exact frozen prototype fragment: agreement title through its final sentence.
export const SERVICE_AGREEMENT_SOURCE_HASH = "28138735125317dc4817bcb5f105b93856b8060842e505be8831a1b9064fe1af";

type Enquiry = typeof schema.enquiries.$inferSelect;

/** Order-independent hash of what was signed. */
export function answersHash(answers: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, canonical(value)]))
        : v;
  return createHash("sha256").update(JSON.stringify(canonical(resumable(answers)))).digest("hex");
}

/** The legal name as the declaration names it: no trailing full stop (§5.1). */
export const declarationName = (legal: string): string => legal.trim().replace(/\.+$/, "");

export async function confirmDesk(db: Db, enquiryId: string, signedName: string): Promise<boolean> {
  return withSignupAccount(db, enquiryId, async (db, account) => {
  if (account.state !== "verified" || !account.pinHash) return false;
  const row = await loadOrCreateOnboarding(db, enquiryId);
  const complete = z.object({ operatingName: z.string().trim().min(1), bizName: z.string().trim().min(1), street: z.string().trim().min(1), city: z.string().trim().min(1), region: z.string().trim().min(1), postal: z.string().trim().min(1), complianceMode: z.enum(["me", "else"]), compName: z.string().optional(), currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1), idOver: z.string().regex(/^\d{1,9}$/) }).safeParse(row.answers);
  if (!complete.success || (complete.data.complianceMode === "else" && !complete.data.compName?.trim())) return false;
  const done = await db.update(schema.signupAccounts).set({
    confirmedAt: new Date(), confirmedName: signedName, declarationVersion: DECLARATION_VERSION,
    answersHash: answersHash(row.answers ?? {}), updatedAt: new Date(),
  }).where(and(eq(schema.signupAccounts.enquiryId, enquiryId), eq(schema.signupAccounts.state, "verified"))).returning();
  if (!done.length) return false;
  const evidenceId = randomUUID();
  const reservation = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, enquiryId)).limit(1))[0];
  if (!reservation) throw new Error("signup_reservation_unavailable");
  const country = typeof reservation.details?.jurisdiction === "string" ? reservation.details.jurisdiction : null;
  await db.insert(schema.signupAgreements).values({ id: evidenceId, enquiryId, accountId: account.accountId, kind: "desk", signerName: signedName,
    declarationVersion: DECLARATION_VERSION, answersHash: answersHash(row.answers ?? {}),
    record: { answers: resumable(row.answers ?? {}), pack: packForCountry(country), declaration: `I confirm these details are true, and I'm authorised to open this desk for ${declarationName(complete.data.bizName)}.` },
  });
  await audit(db, {
    tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", action: "signup.confirmed",
    detail: { enquiryId, agreementId: evidenceId, declaration: DECLARATION_VERSION, answers: answersHash(row.answers ?? {}) },
  });
  return true;
  });
}

/** Still signed: confirmed, and the answers have not moved since. */
export async function stillConfirmed(db: Db, enquiryId: string): Promise<boolean> {
  const account = (await db.select().from(schema.signupAccounts).where(eq(schema.signupAccounts.enquiryId, enquiryId)).limit(1))[0];
  if (!account?.confirmedAt || !account.answersHash) return false;
  const row = await loadOrCreateOnboarding(db, enquiryId);
  return answersHash(row.answers ?? {}) === account.answersHash;
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

/** Integer minor units; annual discounts preserve cents. Website is coming soon. */
export function monthlyFor(c: PlanChoice) {
  const perLocationMinor = SIGNUP_PLANS[c.plan] * (c.term === "annual" ? 90 : 100);
  return { currency: "CAD" as const, perLocationMinor, totalMinor: perLocationMinor * c.locations,
    dueTodayMinor: 0, setupWeekMinor: c.setupWeek ? 500_000 : 0 };
}

/** Every plan and term the plan screen shows, for this many locations, so
 *  the page renders the server's arithmetic and never its own (standards §3).
 *  Integer minor units in the billing currency. A year is twelve months of the
 *  term's per-month figure; the annual saving is against twelve monthly ones. */
export function priceList(locations: number) {
  const n = Math.max(1, Math.min(50, Math.trunc(locations)));
  const quote = (plan: SignupPlan, term: "monthly" | "annual") => {
    const p = monthlyFor({ plan, term, locations: n, brief: true, call: true, website: false, setupWeek: false });
    const monthly = monthlyFor({ plan, term: "monthly", locations: n, brief: true, call: true, website: false, setupWeek: false });
    return { perLocationMinor: p.perLocationMinor, perLocationYearMinor: p.perLocationMinor * 12, aboutPerDayMinor: Math.round(p.perLocationMinor / 30), totalMinor: p.totalMinor, yearMinor: p.totalMinor * 12,
      annualSavingMinor: (monthly.totalMinor - p.totalMinor) * 12, dueTodayMinor: p.dueTodayMinor };
  };
  const plans = Object.fromEntries((Object.keys(SIGNUP_PLANS) as SignupPlan[]).map((plan) =>
    [plan, { monthly: quote(plan, "monthly"), annual: quote(plan, "annual") }])) as Record<SignupPlan, { monthly: ReturnType<typeof quote>; annual: ReturnType<typeof quote> }>;
  return { currency: "CAD" as const, locations: n, setupWeekMinor: 500_000, plans };
}

/** The slice of Stripe this needs. The real client is passed in; tests pass a fake. */
export type SignupStripe = {
  customers: { create(p: { email: string; name: string; metadata: Record<string, string> }, options: { idempotencyKey: string }): Promise<{ id: string }> };
  setupIntents: { create(p: { customer: string; usage: "off_session"; automatic_payment_methods: { enabled: true }; metadata: Record<string, string> }, options: { idempotencyKey: string }): Promise<{ id: string; client_secret: string | null }> };
};

export async function startPayment(db: Db, stripe: SignupStripe, row: Enquiry, choice: PlanChoice, agreed = true) {
  return withSignupAccount(db, row.id, async (db, account) => {
    if (account.state !== "verified" || !account.pinHash || !(await stillConfirmed(db, row.id))) throw new Error("signup_not_confirmed");
    const ob = await loadOrCreateOnboarding(db, row.id);
    const details = row.details ?? {};
    if (signupPack(typeof details.jurisdiction === "string" ? details.jurisdiction : null).billingCurrency !== "CAD") throw new Error("signup_billing_country_unavailable");
    if (choice.website) throw new Error("signup_website_unavailable");
    const answers = ob.answers ?? {};
    const locations = answers.shops === "more" ? z.number().int().min(2).max(50).parse(answers.shopCount) : 1;
    const selected = { ...choice, locations };
    if (!account.confirmedName || !account.answersHash) throw new Error("signup_signature_missing");
    const agreement = createHash("sha256").update(JSON.stringify({ answers: account.answersHash, selected, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH })).digest("hex");
    const metadata = { currencydesk_signup_enquiry: row.id, currencydesk_signup_agreement: agreement };
    const customerId = account.stripeCustomerId ?? z.object({ id: z.string().startsWith("cus_") }).parse(
      await stripe.customers.create({ email: row.email, name: typeof details.shopName === "string" ? details.shopName : row.name ?? "", metadata: { currencydesk_signup_enquiry: row.id } }, { idempotencyKey: `signup-customer-${account.accountId}` })
    ).id;
    const intent = z.object({ id: z.string().startsWith("seti_"), client_secret: z.string().min(1) }).parse(
      await stripe.setupIntents.create({ customer: customerId, usage: "off_session", automatic_payment_methods: { enabled: true }, metadata }, { idempotencyKey: `signup-intent-${account.accountId}-${agreement}` })
    );
    await db.update(schema.signupAccounts).set({
      stripeCustomerId: customerId, setupIntentId: intent.id,
      planChoice: { ...selected, agreement, answersHash: account.answersHash, price: monthlyFor(selected), agreed, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH }, updatedAt: new Date(),
    }).where(eq(schema.signupAccounts.enquiryId, row.id));
    await db.update(schema.onboarding).set({ answers: { ...answers, plan: selected.plan, term: selected.term, brief: selected.brief, call: selected.call }, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, row.id));
    if (agreed) await db.insert(schema.signupAgreements).values({ id: randomUUID(), enquiryId: row.id, accountId: account.accountId, kind: "plan", signerName: account.confirmedName,
      declarationVersion: DECLARATION_VERSION, answersHash: account.answersHash,
      record: { selected, price: monthlyFor(selected), agreed: true, agreement, setupIntentId: intent.id, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH },
    });
    return { clientSecret: intent.client_secret, setupIntentId: intent.id, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH, price: monthlyFor(selected) };
  });
}

const selectedPlan = z.object({ plan: z.enum(["ai", "full", "rates"]), term: z.enum(["monthly", "annual"]), locations: z.number().int().min(1).max(50), brief: z.boolean(), call: z.boolean(), website: z.literal(false), setupWeek: z.boolean() });

/** Open is the assent action. Card preparation never signs for the owner.
 * Bind the displayed version to the exact current intent under the same
 * account lock as edits and activation. Retries retain one evidence row. */
export async function acceptServiceAgreement(db: Db, enquiryId: string, setupIntentId: string): Promise<boolean> {
  return withSignupAccount(db, enquiryId, async (db, account) => {
    if (account.state !== "verified" || !account.pinHash || !account.confirmedName || !account.answersHash
      || account.setupIntentId !== setupIntentId || !(await stillConfirmed(db, enquiryId))) return false;
    const parsed = selectedPlan.extend({ agreement: z.string(), answersHash: z.string(), agreed: z.boolean(), termsSourceHash: z.literal(SERVICE_AGREEMENT_SOURCE_HASH) }).safeParse(account.planChoice);
    if (!parsed.success || parsed.data.answersHash !== account.answersHash) return false;
    if (parsed.data.agreed) return true;
    const selected = selectedPlan.parse(parsed.data);
    await db.insert(schema.signupAgreements).values({ id: randomUUID(), enquiryId, accountId: account.accountId, kind: "plan", signerName: account.confirmedName,
      declarationVersion: DECLARATION_VERSION, answersHash: account.answersHash,
      record: { selected, price: monthlyFor(selected), agreed: true, agreement: parsed.data.agreement, setupIntentId, termsSourceHash: SERVICE_AGREEMENT_SOURCE_HASH },
    });
    await db.update(schema.signupAccounts).set({ planChoice: { ...account.planChoice, agreed: true }, updatedAt: new Date() }).where(eq(schema.signupAccounts.enquiryId, enquiryId));
    return true;
  });
}

/* ---- opening the desk ------------------------------------------------ */

export type OpenResult = { opened: true; tenantId: string } | { opened: false; reason: "unknown_intent" | "not_verified" | "not_confirmed" | "already_open" };

/** Stripe said the card is saved. Create the desk, once. */
export async function openFromSetupIntent(db: Db, intent: { id: string; metadata?: Record<string, string> | null; customer?: string | null; status?: string | null; paymentMethod?: string | null }): Promise<OpenResult> {
  const enquiryId = intent.metadata?.currencydesk_signup_enquiry;
  if (!enquiryId) return { opened: false, reason: "unknown_intent" };
  const account = (await db.select().from(schema.signupAccounts).where(and(
    eq(schema.signupAccounts.enquiryId, enquiryId), eq(schema.signupAccounts.setupIntentId, intent.id),
  )).limit(1))[0];
  if (!account) return { opened: false, reason: "unknown_intent" };
  return withSignupAccount(db, enquiryId, async (db, account): Promise<OpenResult> => {
  if (account.setupIntentId !== intent.id || intent.customer !== account.stripeCustomerId || intent.status !== "succeeded" || !intent.paymentMethod) return { opened: false, reason: "unknown_intent" };
  const choice = selectedPlan.extend({ agreement: z.string(), answersHash: z.string(), agreed: z.literal(true), termsSourceHash: z.literal(SERVICE_AGREEMENT_SOURCE_HASH) }).safeParse(account.planChoice);
  if (!choice.success || choice.data.agreement !== intent.metadata?.currencydesk_signup_agreement || choice.data.answersHash !== account.answersHash || !account.pinHash) return { opened: false, reason: "not_confirmed" };
  if (account.state === "active") return { opened: false, reason: "already_open" };
  if (account.state !== "verified") return { opened: false, reason: "not_verified" };
  if (!(await stillConfirmed(db, enquiryId))) return { opened: false, reason: "not_confirmed" };
  const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, enquiryId)).limit(1))[0];
  const ob = await loadOrCreateOnboarding(db, enquiryId);
  if (ob.tenantId) {
    await advance(db, enquiryId, "active");
    return { opened: false, reason: "already_open" };
  }

  if (!row) throw new Error("signup_reservation_unavailable");
  const stored = ob.answers ?? {};
  // Parse persisted answers again before they can create staff or a desk.
  const values: Record<string, unknown> = {};
  for (const [step, validator] of Object.entries(STEP_FIELDS)) {
    const parsed = validator.safeParse(stored);
    if (!parsed.success) throw new Error(`signup_answers_invalid:${step}`);
    Object.assign(values, parsed.data);
  }
  if (Array.isArray(values.team)) values.team = values.team.map((member) => {
    const m = z.object({ first: z.string(), last: z.string() }).passthrough().parse(member);
    return { ...m, name: `${m.first} ${m.last}`.trim() };
  });
  const callConsent = choice.data.call && (await signupCallPreference(db, enquiryId)).call;
  const resolved = resolve({ ...values, plan: choice.data.plan, term: choice.data.term, brief: choice.data.brief, call: callConsent }, fromApplication(row));
  const spec = specFromAnswers(resolved, row);
  spec.email = row.email;
  const pack = signupPack(typeof row.details?.jurisdiction === "string" ? row.details.jurisdiction : null);
  spec.setup.currencies = [...new Set([pack.homeCurrency, ...(Array.isArray(values.currencies) ? values.currencies : [])])];
  spec.setup.phone = typeof row.details?.phone === "string" ? row.details.phone : "";
  if (spec.setup.address && typeof spec.setup.address === "object") spec.setup.address = { ...spec.setup.address, unit: typeof values.unit === "string" ? values.unit : "" };
  if (values.complianceMode === "me") spec.setup.compliance = { mode: "me", name: row.name ?? "", email: row.email };
  else if (values.complianceMode === "else") spec.setup.compliance = { mode: "other", name: values.compName ?? "", email: values.compEmail ?? "" };
  // Retain what remains to be completed without pretending it is ledger money.
  spec.setup.signup = { version: "2.1", locationCount: choice.data.locations, brief: choice.data.brief, call: callConsent,
    vaultCount: values.count ?? null, vaultCountStatus: values.countLater ? "deferred" : "pending-ledger-integration" };

  const d = row.details ?? {};
  const stagingSlug = isStagingRuntime(undefined) ? stagingOnboardingMark(row.email, row.details) : null;
  spec.isTestShop = !!stagingSlug;
  const wanted = stagingSlug || (typeof d.workspace === "string" ? d.workspace.split(".")[0] : "") || spec.slug;
  spec.slug = await freeSlug(db, wanted ?? spec.slug, row.email);

  const password = (await db.select().from(schema.signupCredentials).where(and(
    eq(schema.signupCredentials.enquiryId, enquiryId), eq(schema.signupCredentials.kind, "password"), isNotNull(schema.signupCredentials.verifiedAt),
  )).limit(1))[0];
  /* A passkey or SSO owner has no password: theirs is a random one nobody
     holds (see KNOWN GAPS). */
  const passwordHash = password?.passwordHash ?? (await hashPassword(randomBytes(32).toString("base64url")));
  const made = await provisionDesk(db, spec, passwordHash, "signup-v2.1", { requireNewTenant: true, requireMarketRates: true });

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
  await db.update(schema.enquiries).set({ status: "accepted", tenantId: made.tenantId, decidedAt: new Date(), decidedBy: "signup-v2.1" }).where(eq(schema.enquiries.id, enquiryId));
  // v2.1 explicitly offers zero = every exchange; legacy zero meant blank.
  if (values.idOver === "0") {
    await db.update(schema.legalEntities).set({ idThreshold: "0.00" }).where(eq(schema.legalEntities.id, made.legalEntityId));
    // The legacy provisioner defaults zero to 3000. Preserve the explicit v2.1
    // choice in both authorities, inside this same activation transaction.
    spec.setup.idThreshold = 0;
    await db.update(schema.tenants).set({ setup: spec.setup }).where(eq(schema.tenants.id, made.tenantId));
  }
  await audit(db, {
    tenantId: made.tenantId, legalEntityId: made.legalEntityId, branchId: made.branchId, actorId: made.ownerId,
    action: "signup.completed", detail: { enquiryId, plan: account.planChoice ?? null, via: "signup-v2.1" },
  });
  return { opened: true, tenantId: made.tenantId };
  });
}
