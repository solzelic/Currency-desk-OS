/* Staging-only fresh shop. Registered only when stagingDoorOpen()
   is true (STAGING exactly "1"; see app.ts). Every request calls
   stagingDoorOpen with the headers. x-forwarded-host and Forwarded
   are not a host. A live host is 404.

   This holds the same pending signup a live owner gets. The shop
   is created by POST /api/signup/verify, which is the real 6-digit
   step. The code and the one-time password are returned in this
   response only. Only their hashes are stored. Nothing is emailed
   and nothing is logged. The body is ignored, so a caller cannot
   name tnt-yorkfx. */
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { clientIp } from "../auth/client-ip.js";
import { hashPassword, temporaryPassword } from "../auth/password.js";
import { stagingDoorOpen, type StagingDoorHeaders } from "../auth/staging-runtime.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { hashCode, makeCode } from "../email.js";
import { slugTaken } from "../onboarding/provision.js";
import { makeReference } from "./enquiries.js";
import { STAGING_DOOR_REASON } from "./early-access.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
export const FRESH_SHOP_IP_MAX = 8;
export const STAGING_OWNER_DOMAIN = "@staging.invalid";

const recent = new Map<string, number[]>();

export function resetFreshShopThrottle(): void {
  recent.clear();
}

export function isStagingFreshShop(
  email: string,
  slug: string,
  headers?: StagingDoorHeaders,
): boolean {
  if (headers !== undefined && !stagingDoorOpen(headers)) return false;
  return slug.startsWith("stg-") && email.endsWith(STAGING_OWNER_DOMAIN);
}

/** Staging door, test-shop row, and an @staging.invalid owner.
    The sign-in code may be shown. Any other account is emailed. */
export async function stagingTestOwnerOnScreen(
  db: Db,
  headers: StagingDoorHeaders,
  staffId: string,
  tenantId: string,
): Promise<boolean> {
  if (!stagingDoorOpen(headers)) return false;
  if (!staffId.toLowerCase().endsWith(STAGING_OWNER_DOMAIN)) return false;
  const row = await db
    .select({ isTestShop: schema.tenants.isTestShop })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  return row[0]?.isTestShop === true;
}

function allow(ip: string): boolean {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= FRESH_SHOP_IP_MAX) return false;
  hits.push(now);
  recent.set(ip, hits);
  return true;
}

/** Invited by the staging door, not by a person. Launch may mark the desk a test shop. */
export function stagingOnboardingMark(
  email: string,
  details: Record<string, unknown> | null | undefined,
  headers?: StagingDoorHeaders,
): string | null {
  if (!details || details.stagingFresh !== true) return null;
  const slug = typeof details.slug === "string" ? details.slug : "";
  if (!isStagingFreshShop(email, slug, headers)) return null;
  return slug;
}

function freshIdentity(): { slug: string; email: string } {
  const id = randomBytes(4).toString("hex");
  return { slug: `stg-${id}`, email: `owner+${id}${STAGING_OWNER_DOMAIN}` };
}

export function registerStagingFreshShopRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/staging/fresh-shop", async (req, reply) => {
    if (!stagingDoorOpen(req.headers as StagingDoorHeaders)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!allow(clientIp(req))) return reply.code(429).send({ error: "slow_down" });

    let slug = "";
    let email = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = freshIdentity();
      if (await slugTaken(db, next.slug, next.email)) continue;
      const used = await db
        .select({ id: schema.staffUsers.id })
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.staffId, next.email))
        .limit(1);
      if (used.length > 0) continue;
      slug = next.slug;
      email = next.email;
      break;
    }
    if (!slug || !email) return reply.code(503).send({ error: "unavailable" });

    const password = temporaryPassword();
    const code = makeCode();
    await db.insert(schema.pendingSignups).values({
      id: randomUUID(),
      email,
      businessName: "Staging test shop",
      ownerName: "Staging owner",
      passwordHash: await hashPassword(password),
      slug,
      onboarding: { plan: "trial" },
      codeHash: hashCode(code),
      attempts: 0,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    return reply.code(201).send({ ok: true, email, slug, code, password });
  });

  /* The sign-in button. An invited application, already past the
     website, the admin click, and the invite email. The page is
     /onboarding/CD-... The body is ignored. */
  app.post("/api/staging/fresh-onboarding", async (req, reply) => {
    if (!stagingDoorOpen(req.headers as StagingDoorHeaders)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!allow(clientIp(req))) return reply.code(429).send({ error: "slow_down" });

    let slug = "";
    let email = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = freshIdentity();
      if (await slugTaken(db, next.slug, next.email)) continue;
      const used = await db
        .select({ id: schema.staffUsers.id })
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.staffId, next.email))
        .limit(1);
      if (used.length > 0) continue;
      slug = next.slug;
      email = next.email;
      break;
    }
    let reference = "";
    for (let attempt = 0; attempt < 5 && slug; attempt++) {
      const next = makeReference();
      const used = await db
        .select({ id: schema.enquiries.id })
        .from(schema.enquiries)
        .where(eq(schema.enquiries.reference, next))
        .limit(1);
      if (used.length > 0) continue;
      reference = next;
      break;
    }
    if (!slug || !email || !reference) return reply.code(503).send({ error: "unavailable" });

    await db.insert(schema.enquiries).values({
      id: randomUUID(),
      reference,
      kind: "early_access",
      email,
      status: "invited",
      charterNo: null,
      isDemo: false,
      doNotContact: true,
      doNotContactReason: STAGING_DOOR_REASON,
      details: { stagingFresh: true, slug },
    });
    return reply.code(201).send({ ok: true, reference, email });
  });
}
