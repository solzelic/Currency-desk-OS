/* ============================================================
   Opening an account, in the order a new shop actually walks.

     1. They accept the terms of service.
     2. Then they create the account.
     3. The CurrencyDesk ID (CD- and six characters) is issued here,
        in that same request, and handed back to be shown. It is not
        a field on the form, and a body that tries to supply one is
        refused.

   This is the public door at /onboarding. It is not the invite-code
   wizard at /onboarding/CD-XXXXXX, and it is not /api/signup. Those
   still exist for an application that already has a reference, and
   for the older email-code signup. A person starting today does not
   need either.

   Shop-record upload is not this route. Nothing here reads a file,
   and nothing here writes an identification as verified.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/sessions.js";
import { makeReference } from "./enquiries.js";
import { closeApplication, freeSlug, provisionDesk, slugFrom, slugTaken } from "../onboarding/provision.js";

/* The legal page is dated 26 July 2026. Accepting the terms means
   accepting that document. Bump this when that page's date changes,
   and bump the sentence on design/onboarding/account-start.html with
   it — the page asks the server for the version before it will
   continue, so a stale page cannot accept a version it has not shown. */
export const ACCOUNT_TERMS_VERSION = "2026-07-26";
export const ACCOUNT_TERMS_UPDATED = "26 July 2026";

/* What this door issues. Six characters, the alphabet makeReference
   uses (no 0/O/1/I). The longer walkthrough code is a different thing
   and is not minted here. */
export const ACCOUNT_REFERENCE_RE = /^CD-[2-9A-HJ-NP-Z]{6}$/;

const emailShape = z.string().trim().toLowerCase().email().max(160);

/* strict() is the gate on the ID. An extra `reference`, `cdId` or
   `code` is not stripped and stored — the request is rejected, and
   no account is created. */
const accountBody = z
  .object({
    businessName: z.string().trim().min(1).max(120),
    ownerName: z.string().trim().min(1).max(120),
    email: emailShape,
    password: z.string().min(8, "password: at least 8 characters").max(512),
    termsAccepted: z.literal(true, { errorMap: () => ({ message: "Accept the terms of service to continue." }) }),
    termsVersion: z.literal(ACCOUNT_TERMS_VERSION, {
      errorMap: () => ({ message: "Accept the current terms of service to continue." }),
    }),
  })
  .strict();

const RESERVED_SLUGS = new Set([
  "api", "app", "www", "sites", "admin", "administrator", "currencydesk", "static",
  "assets", "os-src", "public", "help", "support", "status", "signup", "login", "onboarding",
]);

const recent = new Map<string, number[]>();
function allow(key: string, max: number, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  recent.set(key, hits);
  return true;
}

async function emailInUse(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.staffUsers.id })
    .from(schema.staffUsers)
    .where(eq(schema.staffUsers.staffId, email))
    .limit(1);
  return rows.length > 0;
}

/* Mint, then confirm nobody — desk or application — already holds it.
   The unique index is the real guard; this loop is so a collision
   becomes another try instead of an error the person has to retry. */
async function issueAccountReference(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const reference = makeReference();
    if (!ACCOUNT_REFERENCE_RE.test(reference)) continue;
    const onDesk = await db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.reference, reference))
      .limit(1);
    if (onDesk.length) continue;
    const onApplication = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.reference, reference))
      .limit(1);
    if (onApplication.length) continue;
    return reference;
  }
  throw new Error("could not issue an account reference");
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "23505" || /unique|duplicate key/i.test(String(e?.message ?? ""));
}

export function registerOnboardingAccountRoutes(app: FastifyInstance, db: Db): void {
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };

  /* The page reads this before it enables Continue. The version it
     shows is the version it must send back. */
  app.get("/api/onboarding/account/terms", async () => ({
    version: ACCOUNT_TERMS_VERSION,
    updated: ACCOUNT_TERMS_UPDATED,
    href: "/legal#terms",
  }));

  app.post("/api/onboarding/account", async (req, reply) => {
    const parsed = accountBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        detail: parsed.error.issues[0]?.message ?? "Accept the terms of service to continue.",
      });
    }
    const b = parsed.data;
    if (!allow("account-ip:" + req.ip, 8) || !allow("account-email:" + b.email, 4)) {
      return reply.code(429).send({ error: "slow_down", detail: "Too many attempts — try again in a bit." });
    }
    if (await emailInUse(db, b.email)) {
      return reply.code(409).send({ error: "email_in_use", detail: "That email already has a desk — sign in instead." });
    }

    let slug = slugFrom(b.businessName);
    if (!slug || RESERVED_SLUGS.has(slug)) slug = slugFrom(b.businessName + " exchange") || "desk";
    if (RESERVED_SLUGS.has(slug)) slug = "desk";
    slug = await freeSlug(db, slug, b.email);
    if (await slugTaken(db, slug, b.email)) {
      return reply.code(409).send({ error: "slug_taken", detail: "That desk address is taken — try a slightly different business name." });
    }

    const passwordHash = await hashPassword(b.password);
    const acceptedAt = new Date();
    /* Trial, same as a signup that did not pick a paid tier. The
       commercial plan is a later decision; opening the account does
       not grant one. */
    const { tenantId, ownerId } = await provisionDesk(
      db,
      {
        businessName: b.businessName,
        legalName: b.businessName,
        ownerName: b.ownerName,
        email: b.email,
        slug,
        plan: "trial",
        setup: { openedVia: "onboarding-account", termsVersion: ACCOUNT_TERMS_VERSION },
        msbNumber: null,
        regulator: "FINTRAC",
        team: [],
      },
      passwordHash,
      "onboarding-account",
    );

    /* The ID is written after the desk exists, and only then. A
       collision on the unique index mints another and tries again.
       The response is not sent until the row holds the reference. */
    let reference = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      reference = await issueAccountReference(db);
      try {
        await db
          .update(schema.tenants)
          .set({ reference, termsAcceptedAt: acceptedAt, termsVersion: ACCOUNT_TERMS_VERSION })
          .where(eq(schema.tenants.id, tenantId));
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === 7) throw err;
        reference = "";
      }
    }
    const stored = (
      await db.select({ reference: schema.tenants.reference }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1)
    )[0];
    if (!stored?.reference || stored.reference !== reference) {
      return reply.code(500).send({ error: "reference_failed", detail: "The account was opened but the ID could not be issued. Write to us and we will look it up." });
    }

    await closeApplication(db, { email: b.email }, tenantId, "onboarding-account", { termsVersion: ACCOUNT_TERMS_VERSION });

    const { token, expiresAt } = await createSession(db, ownerId);
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
    return reply.code(201).send({
      ok: true,
      reference,
      tenant: { id: tenantId, name: b.businessName, slug },
    });
  });
}
