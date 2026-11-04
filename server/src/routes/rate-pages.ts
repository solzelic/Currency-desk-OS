/* ============================================================
   Rates v2.5: where a shop's published board is shown.

   Public, no sign-in, cache-friendly, published data only:
     GET /api/public/rate-pages/:slug   the shop's rate page, once live
     GET /api/public/screens/:token     one window screen, by its token

   Desk, signed in, always the caller's own shop:
     GET   /api/rate-page               anyone at the desk
     PUT   /api/rate-page               the owner (site:publish)
     GET   /api/window-screens          anyone at the desk
     POST  /api/window-screens          rates:change
     PATCH /api/window-screens/:id      rates:change
     POST  /api/window-screens/:id/retire  rates:change

   A suspended shop answers 404 everywhere public, the same as a page
   that does not exist, so nothing says whether the name is taken.
   ============================================================ */
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { hasBackendPermission, type BackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { schema, type Db } from "../db/index.js";
import { forgetPublicAnswers, publishedRates, remembered } from "../rates/public-board.js";

/* Lowercase letters, digits and inner hyphens, 3 to 40 long. The database
   holds the same rule, so a direct write cannot store a bad address. */
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
const pageBody = z.object({ slug, live: z.boolean() }).partial().strict();

const currencies = z.array(z.string().regex(/^[A-Z]{3}$/)).max(40)
  .refine((list) => new Set(list).size === list.length, "Each currency once.");
const screenFields = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["tv", "tablet"]),
  layout: z.enum(["one", "two"]),
  theme: z.enum(["light", "dark"]),
  currencies,
  showHours: z.boolean(),
}).strict();

/* An empty list on a screen means the top six of the board, in board order. */
const DEFAULT_SCREEN_COUNT = 6;

/* 24 random bytes, 32 characters of base64url: the screen's only credential. */
const newToken = () => randomBytes(24).toString("base64url");

async function staff(req: FastifyRequest, reply: FastifyReply, db: Db, permission?: BackendPermission): Promise<SessionUser | null> {
  const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
  if (!who) {
    reply.code(401).send({ error: "unauthenticated" });
    return null;
  }
  if (permission && !hasBackendPermission(who.role, permission)) {
    reply.code(403).send({ error: "permission_denied", detail: `${permission} required` });
    return null;
  }
  return who;
}

async function audit(db: Db, who: SessionUser, action: string, detail: Record<string, unknown>) {
  await db.insert(schema.auditEvents).values({
    id: randomUUID(),
    tenantId: who.tenantId,
    legalEntityId: who.legalEntityId,
    branchId: who.branchId,
    actorId: who.id,
    action,
    detail,
  });
}

/* What the shop already publishes on its storefront (tenants.site_config):
   how to reach it and when it is open. Only the fields that are set. */
const CONTACT_FIELDS = ["phone", "email", "address", "city", "region", "postal"] as const;
function publicContact(shop: typeof schema.tenants.$inferSelect) {
  const config = shop.siteConfig ?? {};
  const contact: Partial<Record<(typeof CONTACT_FIELDS)[number], string>> = {};
  for (const field of CONTACT_FIELDS) {
    const value = config[field];
    if (typeof value === "string" && value.trim()) contact[field] = value.trim();
  }
  return { contact, hours: Array.isArray(config.hours) ? config.hours : [] };
}

/* A unique constraint refused the write: Postgres code 23505, which the
   drivers report on the error or on its cause. */
function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function liveShop(db: Db, tenantId: string) {
  const shop = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];
  return shop && !shop.suspended ? shop : null;
}

const screenJson = (row: typeof schema.windowScreens.$inferSelect) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  layout: row.layout,
  theme: row.theme,
  currencies: row.currencies,
  showHours: row.showHours,
  token: row.token,
  createdAt: row.createdAt.getTime(),
});

export function registerRatePageRoutes(app: FastifyInstance, db: Db) {
  const pageAnswer = async (address: string) => {
    const page = (await db.select().from(schema.shopRatePages)
      .where(and(eq(schema.shopRatePages.slug, address), eq(schema.shopRatePages.live, true))).limit(1))[0];
    const shop = page ? await liveShop(db, page.tenantId) : null;
    if (!page || !shop) return null;
    const board = await publishedRates(db, shop.id);
    const { contact, hours } = publicContact(shop);
    return { shop: { name: shop.name, slug: page.slug, home: board.home, contact, hours }, publishedAt: board.publishedAt, rates: board.rates };
  };

  const screenAnswer = async (token: string) => {
    const screen = (await db.select().from(schema.windowScreens)
      .where(and(eq(schema.windowScreens.token, token), isNull(schema.windowScreens.retiredAt))).limit(1))[0];
    const shop = screen ? await liveShop(db, screen.tenantId) : null;
    if (!screen || !shop) return null;
    const board = await publishedRates(db, shop.id);
    const picked = screen.currencies.length
      ? screen.currencies.flatMap((code) => board.rates.filter((rate) => rate.code === code))
      : board.rates.slice(0, DEFAULT_SCREEN_COUNT);
    return {
      shop: { name: shop.name, home: board.home, ...(screen.showHours ? { hours: publicContact(shop).hours } : {}) },
      screen: { name: screen.name, kind: screen.kind, layout: screen.layout, theme: screen.theme, showHours: screen.showHours },
      publishedAt: board.publishedAt,
      rates: picked,
    };
  };

  app.get("/api/public/rate-pages/:slug", async (req, reply) => {
    const parsed = slug.safeParse((req.params as { slug: string }).slug);
    const body = parsed.success ? await remembered(`page:${parsed.data}`, () => pageAnswer(parsed.data)) : null;
    if (!body) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "public, max-age=60");
    return body;
  });

  app.get("/api/public/screens/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const body = /^[A-Za-z0-9_-]{32,64}$/.test(token) ? await remembered(`screen:${token}`, () => screenAnswer(token)) : null;
    if (!body) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "public, max-age=30");
    return body;
  });

  app.get("/api/rate-page", async (req, reply) => {
    const who = await staff(req, reply, db);
    if (!who) return;
    const page = (await db.select().from(schema.shopRatePages).where(eq(schema.shopRatePages.tenantId, who.tenantId)).limit(1))[0];
    return { slug: page?.slug ?? null, live: page?.live ?? false };
  });

  app.put("/api/rate-page", async (req, reply) => {
    const who = await staff(req, reply, db, "site:publish");
    if (!who) return;
    const parsed = pageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const before = (await db.select().from(schema.shopRatePages).where(eq(schema.shopRatePages.tenantId, who.tenantId)).limit(1))[0];
    const next = { slug: parsed.data.slug ?? before?.slug ?? null, live: parsed.data.live ?? before?.live ?? false };
    if (!next.slug) return reply.code(422).send({ error: "slug_required", detail: "Choose an address before the page goes live." });
    /* The address is unique in the database, so two shops asking for it at
       the same moment cannot both have it. The loser is told so, not 500. */
    try {
      await db.insert(schema.shopRatePages)
        .values({ tenantId: who.tenantId, slug: next.slug, live: next.live, updatedBy: who.id })
        .onConflictDoUpdate({
          target: schema.shopRatePages.tenantId,
          set: { slug: next.slug, live: next.live, updatedBy: who.id, updatedAt: new Date() },
        });
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: "slug_taken" });
      throw error;
    }
    for (const field of ["slug", "live"] as const) {
      const old = before ? before[field] : field === "live" ? false : null;
      if (old !== next[field]) await audit(db, who, "rate_page.change", { field, old, new: next[field] });
    }
    forgetPublicAnswers();
    return next;
  });

  app.get("/api/window-screens", async (req, reply) => {
    const who = await staff(req, reply, db);
    if (!who) return;
    const rows = await db.select().from(schema.windowScreens)
      .where(and(eq(schema.windowScreens.tenantId, who.tenantId), isNull(schema.windowScreens.retiredAt)))
      .orderBy(asc(schema.windowScreens.createdAt));
    return { screens: rows.map(screenJson) };
  });

  app.post("/api/window-screens", async (req, reply) => {
    const who = await staff(req, reply, db, "rates:change");
    if (!who) return;
    const parsed = screenFields.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const id = `scr_${randomUUID()}`;
    const [row] = await db.insert(schema.windowScreens)
      .values({ id, tenantId: who.tenantId, ...parsed.data, token: newToken(), createdBy: who.id })
      .returning();
    await audit(db, who, "window_screen.create", { screenId: id, name: parsed.data.name });
    // `returning()` on a single-row insert always yields that row.
    return reply.code(201).send(screenJson(row!));
  });

  app.patch("/api/window-screens/:id", async (req, reply) => {
    const who = await staff(req, reply, db, "rates:change");
    if (!who) return;
    const parsed = screenFields.partial().refine((patch) => Object.keys(patch).length > 0, "Nothing to change.").safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const { id } = req.params as { id: string };
    const [row] = await db.update(schema.windowScreens).set(parsed.data)
      .where(and(eq(schema.windowScreens.id, id), eq(schema.windowScreens.tenantId, who.tenantId), isNull(schema.windowScreens.retiredAt)))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await audit(db, who, "window_screen.change", { screenId: id, fields: Object.keys(parsed.data) });
    forgetPublicAnswers();
    return screenJson(row);
  });

  app.post("/api/window-screens/:id/retire", async (req, reply) => {
    const who = await staff(req, reply, db, "rates:change");
    if (!who) return;
    const { id } = req.params as { id: string };
    const [row] = await db.update(schema.windowScreens).set({ retiredAt: new Date() })
      .where(and(eq(schema.windowScreens.id, id), eq(schema.windowScreens.tenantId, who.tenantId), isNull(schema.windowScreens.retiredAt)))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await audit(db, who, "window_screen.retire", { screenId: id });
    forgetPublicAnswers();
    return { retired: true };
  });
}
