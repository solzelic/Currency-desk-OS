/* ============================================================
   Signup — create a new desk (tenant) with email verification.
     POST /api/signup            { businessName, ownerName, email, password, slug }
       → holds a pending signup, emails a 6-digit code. No tenant yet.
     POST /api/signup/verify     { email, code }
       → on the right code, creates the tenant + owner and signs them in.
     POST /api/signup/resend     { email } → re-sends the code (throttled).

   The tenant is created ONLY after the email is verified, so abandoned
   signups leave no orphan shops. The owner is an administrator whose
   staff id is their email (email-as-identity).
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { sendEmail, makeCode, hashCode, codeMatches, verificationEmail } from "../email.js";
import { tenantPlan } from "./tenant.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESERVED_SLUGS = new Set(["api", "app", "www", "sites", "admin", "administrator", "currencydesk", "static", "assets", "os-src", "public", "help", "support", "status", "signup", "login"]);

const slugShape = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "slug: lowercase letters, digits and hyphens");
const emailShape = z.string().trim().toLowerCase().email().max(160);

// the guided-onboarding answers (all optional): regulator/country, home
// currency, MSB number + address, chosen plan, compliance ID threshold.
const onboardingShape = z
  .object({
    country: z.string().max(60).optional(),
    regulator: z.string().max(60).optional(),
    homeCurrency: z.string().max(8).optional(),
    msbNumber: z.string().max(60).optional(),
    address: z.string().max(160).optional(),
    city: z.string().max(80).optional(),
    region: z.string().max(40).optional(),
    postal: z.string().max(16).optional(),
    plan: z.enum(["basic", "pro", "premium"]).optional(),
    idThreshold: z.number().nonnegative().max(1_000_000).optional(),
  })
  .passthrough();

const signupBody = z.object({
  businessName: z.string().trim().min(1).max(120),
  ownerName: z.string().trim().min(1).max(120),
  email: emailShape,
  password: z.string().min(8, "password: at least 8 characters").max(512),
  slug: slugShape,
  onboarding: onboardingShape.optional(),
});
const verifyBody = z.object({ email: emailShape, code: z.string().trim().min(4).max(10) });
const resendBody = z.object({ email: emailShape });

// simple abuse brakes (in-memory): an email/IP can't spam signup or codes
const recent = new Map<string, number[]>();
const allow = (key: string, max: number, windowMs = 60 * 60 * 1000): boolean => {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  recent.set(key, hits);
  return true;
};

async function slugTaken(db: Db, slug: string, exceptEmail?: string): Promise<boolean> {
  const asTenant = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.siteSlug, slug)).limit(1);
  if (asTenant.length) return true;
  const asPending = await db.select({ email: schema.pendingSignups.email }).from(schema.pendingSignups).where(eq(schema.pendingSignups.slug, slug));
  return asPending.some((p) => p.email !== exceptEmail);
}
async function emailInUse(db: Db, email: string): Promise<boolean> {
  const rows = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.staffId, email)).limit(1);
  return rows.length > 0;
}

export function registerSignupRoutes(app: FastifyInstance, db: Db) {
  const cookieOpts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };

  async function issueCode(email: string, businessName: string): Promise<void> {
    const code = makeCode();
    await db
      .update(schema.pendingSignups)
      .set({ codeHash: hashCode(code), attempts: 0, expiresAt: new Date(Date.now() + CODE_TTL_MS) })
      .where(eq(schema.pendingSignups.email, email));
    const mail = verificationEmail(code, businessName);
    await sendEmail(email, mail.subject, { text: mail.text, html: mail.html });
  }

  app.post("/api/signup", async (req, reply) => {
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const b = parsed.data;
    if (RESERVED_SLUGS.has(b.slug)) return reply.code(409).send({ error: "slug_reserved", detail: "That desk address is reserved — pick another." });
    if (!allow("signup-ip:" + req.ip, 8) || !allow("signup-email:" + b.email, 4)) {
      return reply.code(429).send({ error: "slow_down", detail: "Too many attempts — try again in a bit." });
    }
    if (await slugTaken(db, b.slug, b.email)) return reply.code(409).send({ error: "slug_taken", detail: "That desk address is taken — pick another." });
    if (await emailInUse(db, b.email)) {
      // don't reveal account existence in an obvious way, but block the collision
      return reply.code(409).send({ error: "email_in_use", detail: "That email already has a desk — sign in instead." });
    }

    const passwordHash = await hashPassword(b.password);
    const row = {
      id: randomUUID(),
      email: b.email,
      businessName: b.businessName,
      ownerName: b.ownerName,
      passwordHash,
      slug: b.slug,
      onboarding: b.onboarding ?? null,
      codeHash: "", // set by issueCode
      attempts: 0,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    };
    // one pending per email — replace any prior attempt
    await db.insert(schema.pendingSignups).values(row).onConflictDoUpdate({
      target: schema.pendingSignups.email,
      set: { businessName: row.businessName, ownerName: row.ownerName, passwordHash, slug: row.slug, onboarding: row.onboarding },
    });
    await issueCode(b.email, b.businessName);
    return reply.code(201).send({ ok: true, email: b.email });
  });

  app.post("/api/signup/resend", async (req, reply) => {
    const parsed = resendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!allow("resend:" + parsed.data.email, 4)) return reply.code(429).send({ error: "slow_down", detail: "Hold on — wait before requesting another code." });
    const rows = await db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, parsed.data.email)).limit(1);
    const p = rows[0];
    if (p) await issueCode(p.email, p.businessName);
    return { ok: true }; // uniform response — don't reveal whether a pending signup exists
  });

  app.post("/api/signup/verify", async (req, reply) => {
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { email, code } = parsed.data;
    const rows = await db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, email)).limit(1);
    const p = rows[0];
    if (!p) return reply.code(404).send({ error: "no_pending", detail: "Start the signup again — we couldn't find it." });
    if (p.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired", detail: "That code expired — request a new one." });
    if (p.attempts >= MAX_ATTEMPTS) return reply.code(429).send({ error: "too_many_attempts", detail: "Too many tries — request a new code." });
    if (!codeMatches(code, p.codeHash)) {
      await db.update(schema.pendingSignups).set({ attempts: p.attempts + 1 }).where(eq(schema.pendingSignups.email, email));
      return reply.code(401).send({ error: "wrong_code", detail: "That code isn't right — check the email and try again." });
    }

    // verified — create the tenant + owner. Guard against a race where the slug
    // got taken between signup and verify.
    if (await slugTaken(db, p.slug, email)) return reply.code(409).send({ error: "slug_taken", detail: "That desk address was just taken — pick another." });

    const onb = (p.onboarding ?? {}) as Record<string, unknown>;
    const chosenPlan = typeof onb.plan === "string" && ["basic", "pro", "premium"].includes(onb.plan) ? (onb.plan as string) : "trial";
    const regulator = typeof onb.regulator === "string" && onb.regulator ? onb.regulator : "FINTRAC";
    const msbNumber = typeof onb.msbNumber === "string" ? onb.msbNumber : null;

    const tenantId = "tnt-" + p.slug;
    const legalEntityId = "le-" + p.slug;
    const branchId = "br-" + p.slug + "-main";
    const workspaceId = "ws-" + p.slug + "-till-01";
    await db.insert(schema.tenants).values({ id: tenantId, name: p.businessName, plan: chosenPlan, siteSlug: p.slug, setup: p.onboarding ?? null }).onConflictDoNothing();
    await db.insert(schema.legalEntities).values({ id: legalEntityId, tenantId, name: p.businessName, msbNumber, jurisdiction: regulator }).onConflictDoNothing();
    await db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "Main" }).onConflictDoNothing();
    await db.insert(schema.workspaces).values({ id: workspaceId, tenantId, legalEntityId, branchId, tillId: "till-01" }).onConflictDoNothing();
    const ownerId = `${tenantId}:${email}`;
    await db.insert(schema.staffUsers).values({
      id: ownerId,
      tenantId,
      legalEntityId,
      branchId,
      staffId: email, // email-as-identity for the owner
      name: p.ownerName,
      role: "administrator",
      authorizedBranchIds: [branchId],
      passwordHash: p.passwordHash,
      mustChangePassword: false,
      passwordUpdatedAt: new Date(),
    }).onConflictDoNothing();
    await db.delete(schema.pendingSignups).where(eq(schema.pendingSignups.email, email));

    await audit(db, { tenantId, legalEntityId, branchId, actorId: ownerId, action: "tenant.created", detail: { via: "signup", slug: p.slug, email } });

    const { token, expiresAt } = await createSession(db, ownerId);
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
    // the DB records the raw plan ('trial') for future billing; entitlement is
    // resolved by tenantPlan (trial → premium-level access during the trial)
    const plan = await tenantPlan(db, tenantId);
    return reply.code(201).send({
      user: { id: email, name: p.ownerName, role: "administrator", tenantId, legalEntityId, branchId, authorizedBranchIds: [branchId], mustChangePassword: false, plan },
      tenant: { id: tenantId, name: p.businessName, slug: p.slug, plan },
    });
  });
}
