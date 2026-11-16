/* Staging-only fresh shop. Registered only when stagingDoorOpen()
   is true (STAGING exactly "1"; see app.ts). Every request calls
   stagingDoorOpen with the headers. x-forwarded-host and Forwarded
   are not a host. A live host is 404.

   This holds the same pending signup a live owner gets. The shop
   is created by POST /api/signup/verify, which is the real 6-digit
   step. The code and the one-time password are returned in this
   response only. Only their hashes are stored. Nothing is emailed
   and nothing is logged. The body is ignored, so a caller cannot
   name tnt-yorkfx.

   Also shared with Start on Day 1 (routes/staging-day-one.ts): the
   staging identity (freshStagingIdentity) and the per-address count
   (8 an hour, an IPv6 /64 as one address), plus Day 1's own
   process-wide ceiling (allowDayOne). */
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
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
/* Start on Day 1 provisions a whole desk per press, so on top of the
   per-address count the whole process takes at most this many an hour. */
export const DAY_ONE_HOURLY_MAX = 30;
export const STAGING_OWNER_DOMAIN = "@staging.invalid";

const recent = new Map<string, number[]>();
const dayOnePresses: number[] = [];

/* The Early Access v2.1 start (U5b). The button hands out a one-time
   ticket bound to a staging identity and opens the website with it; the
   way into the application carries it, and the page applies with it. A
   ticket lives two hours (time to look round the site), opens one
   application, and only on the staging door. In memory: a restart drops
   them, and the button makes another. */
const TICKET_TTL_MS = 2 * 60 * 60 * 1000;
const tickets = new Map<string, { email: string; slug: string; expires: number }>();

type Held = { email: string; slug: string; expires: number };

/** The staging identity behind a ticket, without using it: the door must be
    open, the ticket real and unexpired. Anything else is null. */
export function peekStagingTicket(ticket: string, headers: StagingDoorHeaders): Held | null {
  if (!stagingDoorOpen(headers)) return null;
  const held = tickets.get(ticket);
  return held && held.expires > Date.now() ? { ...held } : null;
}

/** The same, and the ticket is used: only once, by whoever takes it first.
    Taken at the last step before an application is saved, so a refusal
    before then (a throttle, a bad answer) leaves it for the next press. */
export function takeStagingTicket(ticket: string, headers: StagingDoorHeaders): Held | null {
  const held = peekStagingTicket(ticket, headers);
  tickets.delete(ticket);
  return held;
}

/** Put back a ticket whose application then failed to save. */
export function restoreStagingTicket(ticket: string, held: Held): void {
  if (held.expires > Date.now()) tickets.set(ticket, held);
}

export function resetFreshShopThrottle(): void {
  recent.clear();
  tickets.clear();
  dayOnePresses.length = 0;
}

/** How many address buckets the throttle holds now. For tests. */
export const freshShopTracked = (): number => recent.size;

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

/* The groups of an IPv6 address before its interface id, e.g. 2001:db8:1:2.
   An embedded IPv4 tail counts as two groups. */
function v6Prefix(ip: string): string {
  const lower = ip.toLowerCase();
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const [head = "", tail] = lower.includes("::") ? lower.split("::") : [lower, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - width(left) - width(right))).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":");
}

/** The address a press is counted against: an IPv4 address as it is, and
    an IPv6 address by its /64, since one host's /64 is cheap to rotate. */
export function freshShopBucket(ip: string): string {
  return isIP(ip) === 6 ? `${v6Prefix(ip)}::/64` : ip;
}

/* Presses from this bucket inside the hour. Expired buckets are dropped,
   so the map holds only addresses seen this hour. */
function recentHits(key: string, now: number): number[] {
  for (const [k, times] of recent) if (!times.some((t) => now - t < WINDOW_MS)) recent.delete(k);
  return (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
}

/** One more staging press from this address, if it has room this hour. */
export function allowFreshShop(ip: string): boolean {
  const now = Date.now();
  const key = freshShopBucket(ip);
  const hits = recentHits(key, now);
  if (hits.length >= FRESH_SHOP_IP_MAX) return false;
  recent.set(key, [...hits, now]);
  return true;
}

/** Start on Day 1: the same per-address count as Start a fresh shop, and
    the process-wide hourly ceiling. Both are checked before either counts. */
export function allowDayOne(ip: string): boolean {
  const now = Date.now();
  const key = freshShopBucket(ip);
  const hits = recentHits(key, now);
  while (dayOnePresses.length && now - dayOnePresses[0]! >= WINDOW_MS) dayOnePresses.shift();
  if (hits.length >= FRESH_SHOP_IP_MAX || dayOnePresses.length >= DAY_ONE_HOURLY_MAX) return false;
  recent.set(key, [...hits, now]);
  dayOnePresses.push(now);
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

export type StagingIdentity = { slug: string; email: string; hex: string };

function freshIdentity(): StagingIdentity {
  const id = randomBytes(4).toString("hex");
  return { slug: `stg-${id}`, email: `owner+${id}${STAGING_OWNER_DOMAIN}`, hex: id };
}

/** A staging identity nobody holds: no tenant or pending signup on the slug,
    no staff sign-in, application or live ticket on the email. Null after
    five tries. Writes nothing. */
export async function freshStagingIdentity(db: Db): Promise<StagingIdentity | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = freshIdentity();
    if (await slugTaken(db, next.slug, next.email)) continue;
    const used = await db
      .select({ id: schema.staffUsers.id })
      .from(schema.staffUsers)
      .where(eq(schema.staffUsers.staffId, next.email))
      .limit(1);
    if (used.length > 0) continue;
    const applied = await db
      .select({ id: schema.enquiries.id })
      .from(schema.enquiries)
      .where(eq(schema.enquiries.email, next.email))
      .limit(1);
    if (applied.length > 0) continue;
    if ([...tickets.values()].some((held) => held.email === next.email)) continue;
    return next;
  }
  return null;
}

export function registerStagingFreshShopRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/staging/fresh-shop", async (req, reply) => {
    if (!stagingDoorOpen(req.headers as StagingDoorHeaders)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!allowFreshShop(clientIp(req))) return reply.code(429).send({ error: "slow_down" });

    const identity = await freshStagingIdentity(db);
    if (!identity) return reply.code(503).send({ error: "unavailable" });
    const { slug, email } = identity;

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

  /* The sign-in button. It starts the whole journey where a new shop
     starts, on the website (Sol, 14 Nov): a one-time ticket and a staging
     identity, and the homepage address to open with them. The way in
     carries the ticket to the Early Access v2.1 page, the page applies
     with it (routes/enquiries.ts reads it), the application is accepted
     at once, and "Start building your desk" opens /onboarding/CD-...
     Nothing is emailed. The body is ignored. */
  app.post("/api/staging/fresh-onboarding", async (req, reply) => {
    if (!stagingDoorOpen(req.headers as StagingDoorHeaders)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!allowFreshShop(clientIp(req))) return reply.code(429).send({ error: "slow_down" });

    const identity = await freshStagingIdentity(db);
    if (!identity) return reply.code(503).send({ error: "unavailable" });
    const { slug, email } = identity;

    const ticket = randomBytes(16).toString("hex");
    const now = Date.now();
    for (const [key, held] of tickets) if (held.expires <= now) tickets.delete(key);
    tickets.set(ticket, { email, slug, expires: now + TICKET_TTL_MS });
    const start = `/?door=${ticket}&email=${encodeURIComponent(email)}`;
    return reply.code(201).send({ ok: true, start, email });
  });
}
