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

const CODE_TTL_MS = 10 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
export const FRESH_SHOP_IP_MAX = 8;
export const STAGING_OWNER_DOMAIN = "@staging.invalid";

const recent = new Map<string, number[]>();

export function resetFreshShopThrottle(): void {
  recent.clear();
}

export function isStagingFreshShop(email: string, slug: string): boolean {
  return slug.startsWith("stg-") && email.endsWith(STAGING_OWNER_DOMAIN);
}

function allow(ip: string): boolean {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= FRESH_SHOP_IP_MAX) return false;
  hits.push(now);
  recent.set(ip, hits);
  return true;
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
}
