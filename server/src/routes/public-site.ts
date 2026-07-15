/* ============================================================
   Public storefront APIs — no session; these serve the hosted
   customer sites (and the same site on a customer's own domain).

     GET  /api/sites/:slug/config          → contact + hours the OS published
     GET  /api/site/config                 → same, resolved from the Host header
     POST /api/sites/:slug/quotes          → SMS rate-hold: price it off the
          published board, hold for 30 min, text the customer
     POST /api/sites/:slug/quotes/:ref/confirm → customer confirms pickup
     GET  /api/quotes                      → staff view (session required)

   Pricing uses the SAME published board the desk runs on: we buy
   foreign under mid, sell over mid, per-currency spreads override
   the board margins. Cross pairs settle through CAD, like the desk.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { normalizePhone, sendSms } from "../sms.js";
import { SITES, siteSlugForHost } from "../sites.js";

const HOLD_MINUTES = 30;

const quoteBody = z.object({
  phone: z.string().min(7).max(24),
  name: z.string().trim().max(80).optional(),
  from: z.string().regex(/^[A-Z]{3}$/),
  to: z.string().regex(/^[A-Z]{3}$/),
  amount: z.number().positive().max(1_000_000),
}).refine((b) => b.from !== b.to, { message: "currencies must differ" });

// simple abuse brake: a phone gets 3 quotes an hour, an IP gets 10
const recent = new Map<string, number[]>();
const allow = (key: string, max: number): boolean => {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= max) return false;
  hits.push(now);
  recent.set(key, hits);
  return true;
};

async function tenantForSlug(db: Db, slug: string) {
  if (!SITES[slug]) return null;
  const rows = await db.select().from(schema.tenants).where(eq(schema.tenants.siteSlug, slug)).limit(1);
  return rows[0] ?? null;
}

const publicConfig = (t: typeof schema.tenants.$inferSelect) => ({
  name: t.name,
  slug: t.siteSlug,
  ...(t.siteConfig ?? {}),
});

async function latestBoard(db: Db, tenantId: string) {
  const rows = await db
    .select()
    .from(schema.rateBoards)
    .where(eq(schema.rateBoards.tenantId, tenantId))
    .orderBy(desc(schema.rateBoards.publishedAt))
    .limit(1);
  return rows[0] ?? null;
}

const fmtAmount = (n: number, ccy: string) =>
  `${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
const fmtTime = (d: Date) =>
  d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" });

const quoteJson = (q: typeof schema.rateQuotes.$inferSelect) => {
  const status = q.status === "held" && q.expiresAt.getTime() < Date.now() ? "expired" : q.status;
  return {
    ref: q.id,
    phone: q.phone,
    name: q.name,
    from: q.haveCcy,
    to: q.wantCcy,
    amount: q.haveAmount,
    rate: q.quotedRate,
    receive: q.receiveAmount,
    status,
    smsStatus: q.smsStatus,
    expiresAt: q.expiresAt.getTime(),
    createdAt: q.createdAt.getTime(),
  };
};

export function registerPublicSiteRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/sites/:slug/config", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const t = await tenantForSlug(db, slug);
    if (!t) return reply.code(404).send({ error: "not_found" });
    return { site: publicConfig(t) };
  });

  // the same lookup for custom-domain visitors, where the path carries no slug
  app.get("/api/site/config", async (req, reply) => {
    const slug = siteSlugForHost(req.headers.host);
    if (!slug) return reply.code(404).send({ error: "no_site_for_host" });
    const t = await tenantForSlug(db, slug);
    if (!t) return reply.code(404).send({ error: "not_found" });
    return { site: publicConfig(t) };
  });

  app.post("/api/sites/:slug/quotes", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const t = await tenantForSlug(db, slug);
    if (!t) return reply.code(404).send({ error: "not_found" });
    const parsed = quoteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const b = parsed.data;

    const phone = normalizePhone(b.phone);
    if (!phone) return reply.code(400).send({ error: "invalid_phone", detail: "Enter a mobile number we can text." });
    if (!allow("p:" + phone, 3) || !allow("ip:" + req.ip, 10)) {
      return reply.code(429).send({ error: "slow_down", detail: "Too many quotes — try again in a bit, or call the desk." });
    }

    const board = await latestBoard(db, t.id);
    if (!board) return reply.code(503).send({ error: "no_board" });
    const rowOf = (ccy: string) => board.boardRows[ccy];
    if (b.from !== "CAD" && !rowOf(b.from)) return reply.code(400).send({ error: "unknown_currency", detail: b.from });
    if (b.to !== "CAD" && !rowOf(b.to)) return reply.code(400).send({ error: "unknown_currency", detail: b.to });

    // desk math: we buy foreign under mid, sell over mid; crosses go via CAD
    const buyRate = (ccy: string) => rowOf(ccy)!.mid * (1 - (rowOf(ccy)!.spread ?? board.buyMargin));
    const sellRate = (ccy: string) => rowOf(ccy)!.mid * (1 + (rowOf(ccy)!.spread ?? board.sellMargin));
    const cad = b.from === "CAD" ? b.amount : b.amount * buyRate(b.from);
    const receive = b.to === "CAD" ? cad : cad / sellRate(b.to);
    const rate = receive / b.amount;

    // customer-facing ref, retried on the rare collision
    let ref = "";
    for (let i = 0; i < 6; i++) {
      ref = "Q-" + Math.floor(1000 + Math.random() * 9000);
      const clash = await db.select({ id: schema.rateQuotes.id }).from(schema.rateQuotes).where(eq(schema.rateQuotes.id, ref)).limit(1);
      if (clash.length === 0) break;
      ref = "";
    }
    if (!ref) return reply.code(503).send({ error: "try_again" });

    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
    // opt-out line on the initiating text keeps A2P 10DLC compliant; Twilio
    // auto-handles the STOP keyword, so no unsubscribe list to maintain here
    const smsText =
      `${t.name}: ${fmtAmount(b.amount, b.from)} → ${fmtAmount(receive, b.to)}. ` +
      `Rate held for ${HOLD_MINUTES} min (until ${fmtTime(expiresAt)}). Ref ${ref} — show this text at the desk. Reply STOP to opt out.`;
    const smsStatus = await sendSms(phone, smsText);

    await db.insert(schema.rateQuotes).values({
      id: ref,
      tenantId: t.id,
      phone,
      name: b.name ?? null,
      haveCcy: b.from,
      wantCcy: b.to,
      haveAmount: b.amount,
      quotedRate: rate,
      receiveAmount: receive,
      smsStatus,
      smsText,
      expiresAt,
    });
    const rows = await db.select().from(schema.rateQuotes).where(eq(schema.rateQuotes.id, ref)).limit(1);
    return reply.code(201).send({ quote: quoteJson(rows[0]!) });
  });

  app.post("/api/sites/:slug/quotes/:ref/confirm", async (req, reply) => {
    const { slug, ref } = req.params as { slug: string; ref: string };
    const t = await tenantForSlug(db, slug);
    if (!t) return reply.code(404).send({ error: "not_found" });
    const rows = await db.select().from(schema.rateQuotes).where(eq(schema.rateQuotes.id, ref)).limit(1);
    const q = rows[0];
    if (!q || q.tenantId !== t.id) return reply.code(404).send({ error: "not_found" });
    if (q.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });
    if (q.status === "held") {
      await db.update(schema.rateQuotes).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(schema.rateQuotes.id, ref));
      void sendSms(q.phone, `${t.name}: Ref ${ref} confirmed — ${fmtAmount(q.receiveAmount, q.wantCcy)} set aside until ${fmtTime(q.expiresAt)}. See you soon.`);
    }
    const fresh = await db.select().from(schema.rateQuotes).where(eq(schema.rateQuotes.id, ref)).limit(1);
    return { quote: quoteJson(fresh[0]!) };
  });

  // staff: the desk's incoming holds (any signed-in role — tellers serve them)
  app.get("/api/quotes", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const rows = await db
      .select()
      .from(schema.rateQuotes)
      .where(eq(schema.rateQuotes.tenantId, who.tenantId))
      .orderBy(desc(schema.rateQuotes.createdAt))
      .limit(100);
    return { quotes: rows.map(quoteJson) };
  });
}
