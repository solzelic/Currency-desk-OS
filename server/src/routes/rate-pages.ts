/* ============================================================
   Rates v2.5: where a shop's published board is shown.

   Public, no sign-in, cache-friendly, published data only:
     GET /api/public/rate-pages/:slug   the shop's rate page, once live
     GET /api/public/screens/:token     one window screen, by its token
     GET /api/public/rate-pages/:slug/logo, /api/public/screens/:token/logo

   Desk, signed in, always the caller's own shop:
     GET   /api/rate-page               anyone at the desk (made on first ask)
     PUT   /api/rate-page               the owner (site:publish)
     PATCH /api/rate-page/content       rates:change; the regulator block
                                        is the owner's (site:publish)
     GET   /api/rate-page/preview       anyone at the desk, live or not
     PUT   /api/rate-page/logo          rates:change (a checked PNG)
     DELETE /api/rate-page/logo         rates:change
     GET   /api/rate-page/logo          anyone at the desk (the preview's)
     GET   /api/window-screens          anyone at the desk
     POST  /api/window-screens          rates:change
     PATCH /api/window-screens/:id      rates:change
     POST  /api/window-screens/:id/retire  rates:change
     POST  /api/window-screens/:id/reset   rates:change (a new link)

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
import { contentPatch, ensureRatePage, resolvedContent, validWeek } from "../rates/rate-page.js";
import { checkLogo, LOGO_HEADERS, logoBytes } from "../rates/logo.js";

/* Lowercase letters, digits and inner hyphens, 3 to 40 long. The database
   holds the same rule, so a direct write cannot store a bad address. */
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
const pageBody = z.object({ slug, live: z.boolean() }).partial().strict();

const currencies = z.array(z.string().regex(/^[A-Z]{3}$/)).max(40)
  .refine((list) => new Set(list).size === list.length, "Each currency once.");
const screenFields = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["tv", "portrait", "tablet", "strip"]),
  layout: z.enum(["one", "two", "rotate"]),
  theme: z.enum(["light", "dark"]),
  currencies,
  showHours: z.boolean(),
  /* What shows on the screen; a part left out is shown. */
  show: z.object({ flags: z.boolean(), names: z.boolean(), clock: z.boolean(), logo: z.boolean() }).partial().strict().optional(),
}).strict();
const shownOn = (show: typeof schema.windowScreens.$inferSelect["show"] | null) => ({
  flags: show?.flags ?? true, names: show?.names ?? true, clock: show?.clock ?? true, logo: show?.logo ?? true,
});

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
  show: shownOn(row.show),
  token: row.token,
  createdAt: row.createdAt.getTime(),
});

/* An empty or unset list on the rate page means the top six of the board. */
const DEFAULT_PAGE_COUNT = 6;

export function registerRatePageRoutes(app: FastifyInstance, db: Db) {
  /* What the rate page shows: the shop's published board and what the
     shop wrote for its page. The same answer for the public page and the
     desk's preview, so the preview is the page. */
  const answerFor = async (page: typeof schema.shopRatePages.$inferSelect, shop: typeof schema.tenants.$inferSelect, preview = false) => {
    const board = await publishedRates(db, shop.id);
    const content = await resolvedContent(db, shop.id, shop.name, page.content ?? {});
    const { contact, hours } = publicContact(shop);
    const week = validWeek(shop.siteConfig?.week);
    const rates = content.codes?.length
      ? content.codes.flatMap((code) => board.rates.filter((rate) => rate.code === code))
      : board.rates.slice(0, DEFAULT_PAGE_COUNT);
    const reg = content.regulator;
    return {
      shop: {
        name: content.name,
        slug: page.slug,
        home: board.home,
        ...(board.timeZone ? { timeZone: board.timeZone } : {}),
        ...(content.tagline ? { tagline: content.tagline } : {}),
        /* The logo's own address; ?v changes with each upload so a browser
           never keeps an old one. */
        ...(page.logo && page.logoAt ? { logo: `${preview ? "/api/rate-page/logo" : `/api/public/rate-pages/${page.slug}/logo`}?v=${page.logoAt.getTime()}` } : {}),
        contact,
        hours,
        ...(week ? { week } : {}),
        show: content.show,
        /* A regulator is shown only with both its name and the number. */
        ...(reg.name && reg.number ? { regulator: reg } : {}),
      },
      publishedAt: board.publishedAt,
      rates,
    };
  };

  const pageAnswer = async (address: string) => {
    const page = (await db.select().from(schema.shopRatePages)
      .where(and(eq(schema.shopRatePages.slug, address), eq(schema.shopRatePages.live, true))).limit(1))[0];
    const shop = page ? await liveShop(db, page.tenantId) : null;
    return page && shop ? answerFor(page, shop) : null;
  };

  const screenAnswer = async (token: string) => {
    const screen = (await db.select().from(schema.windowScreens)
      .where(and(eq(schema.windowScreens.token, token), isNull(schema.windowScreens.retiredAt))).limit(1))[0];
    const shop = screen ? await liveShop(db, screen.tenantId) : null;
    if (!screen || !shop) return null;
    const board = await publishedRates(db, shop.id);
    /* The shop's page, if it has one yet, for the logo and regulator; the
       business profile for the week. */
    const page = (await db.select().from(schema.shopRatePages).where(eq(schema.shopRatePages.tenantId, shop.id)).limit(1))[0];
    const content = await resolvedContent(db, shop.id, shop.name, page?.content ?? {});
    const show = shownOn(screen.show);
    const week = validWeek(shop.siteConfig?.week);
    const reg = content.regulator;
    const picked = screen.currencies.length
      ? screen.currencies.flatMap((code) => board.rates.filter((rate) => rate.code === code))
      : board.rates.slice(0, DEFAULT_SCREEN_COUNT);
    return {
      shop: {
        name: shop.name,
        home: board.home,
        ...(board.timeZone ? { timeZone: board.timeZone } : {}),
        ...(screen.showHours ? { hours: publicContact(shop).hours } : {}),
        ...(week ? { week } : {}),
        ...(reg.name && reg.number ? { regulator: reg } : {}),
        ...(show.logo && page?.logo && page.logoAt ? { logo: `/api/public/screens/${token}/logo?v=${page.logoAt.getTime()}` } : {}),
      },
      screen: { name: screen.name, kind: screen.kind, layout: screen.layout, theme: screen.theme, showHours: screen.showHours, show },
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

  /* The desk's view of its page: the address, live or not, what the shop
     wrote with defaults filled in, and the business profile it shares
     with Settings. */
  const deskView = async (tenantId: string) => {
    const page = await ensureRatePage(db, tenantId);
    const shop = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0]!;
    const config = shop.siteConfig ?? {};
    const profile = Object.fromEntries((["phone", "email", "address", "city", "region", "postal"] as const).map((f) => [f, config[f] ?? ""]));
    return {
      slug: page.slug,
      live: page.live,
      logo: page.logo && page.logoAt ? `/api/rate-page/logo?v=${page.logoAt.getTime()}` : null,
      content: await resolvedContent(db, tenantId, shop.name, page.content ?? {}),
      profile: { ...profile, week: validWeek(config.week) },
    };
  };

  app.get("/api/rate-page", async (req, reply) => {
    const who = await staff(req, reply, db);
    if (!who) return;
    return deskView(who.tenantId);
  });

  app.patch("/api/rate-page/content", async (req, reply) => {
    const who = await staff(req, reply, db, "rates:change");
    if (!who) return;
    const parsed = contentPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    /* The regulator block is what the law asks the page to say: the
       owner's to change. */
    if (parsed.data.regulator && !hasBackendPermission(who.role, "site:publish")) {
      return reply.code(403).send({ error: "permission_denied", detail: "site:publish required" });
    }
    const page = await ensureRatePage(db, who.tenantId);
    const { profile, ...written } = parsed.data;
    if (Object.keys(written).length) {
      await db.update(schema.shopRatePages)
        .set({ content: { ...(page.content ?? {}), ...written }, updatedBy: who.id, updatedAt: new Date() })
        .where(eq(schema.shopRatePages.tenantId, who.tenantId));
    }
    /* Contact and hours live in the business profile, so Settings and the
       page always say the same. Fields not sent are kept. */
    if (profile) {
      const shop = (await db.select({ config: schema.tenants.siteConfig }).from(schema.tenants).where(eq(schema.tenants.id, who.tenantId)).limit(1))[0];
      await db.update(schema.tenants)
        .set({ siteConfig: { ...(shop?.config ?? {}), ...profile, updatedAt: new Date().toISOString() } })
        .where(eq(schema.tenants.id, who.tenantId));
    }
    await audit(db, who, "rate_page.content", {
      fields: Object.keys(parsed.data),
      ...(parsed.data.regulator ? { regulator: { old: page.content?.regulator ?? null, new: parsed.data.regulator } } : {}),
    });
    forgetPublicAnswers();
    return deskView(who.tenantId);
  });

  /* The page as it will look, before it is live: signed in only, and
     never cached anywhere but this browser (the /api no-store rule). */
  app.get("/api/rate-page/preview", async (req, reply) => {
    const who = await staff(req, reply, db);
    if (!who) return;
    const page = await ensureRatePage(db, who.tenantId);
    const shop = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, who.tenantId)).limit(1))[0]!;
    return answerFor(page, shop, true);
  });

  /* ---- the logo ---- */
  const sendLogo = (reply: FastifyReply, stored: string | null | undefined, cache: string) => {
    const bytes = logoBytes(stored);
    if (!bytes) return reply.code(404).send({ error: "not_found" });
    reply.headers({ ...LOGO_HEADERS, "cache-control": cache });
    return reply.send(bytes);
  };

  app.put("/api/rate-page/logo", async (req, reply) => {
    const who = await staff(req, reply, db, "rates:change");
    if (!who) return;
    const checked = checkLogo((req.body as { dataUrl?: unknown } | null)?.dataUrl);
    if (!checked) return reply.code(400).send({ error: "invalid_logo", detail: "A PNG of up to 256 KB and 1024 by 1024 pixels." });
    await ensureRatePage(db, who.tenantId);
    await db.update(schema.shopRatePages).set({ logo: checked.dataUrl, logoAt: new Date(), updatedBy: who.id, updatedAt: new Date() })
      .where(eq(schema.shopRatePages.tenantId, who.tenantId));
    await audit(db, who, "rate_page.logo", { set: true, bytes: checked.bytes.length });
    forgetPublicAnswers();
    return deskView(who.tenantId);
  });

  app.delete("/api/rate-page/logo", async (req, reply) => {
    const who = await staff(req, reply, db, "rates:change");
    if (!who) return;
    await db.update(schema.shopRatePages).set({ logo: null, logoAt: null, updatedBy: who.id, updatedAt: new Date() })
      .where(eq(schema.shopRatePages.tenantId, who.tenantId));
    await audit(db, who, "rate_page.logo", { set: false });
    forgetPublicAnswers();
    return deskView(who.tenantId);
  });

  app.get("/api/rate-page/logo", async (req, reply) => {
    const who = await staff(req, reply, db);
    if (!who) return;
    const page = (await db.select({ logo: schema.shopRatePages.logo }).from(schema.shopRatePages).where(eq(schema.shopRatePages.tenantId, who.tenantId)).limit(1))[0];
    return sendLogo(reply, page?.logo, "private, no-store");
  });

  /* Public: only a live page's logo, or a screen's that shows it. */
  app.get("/api/public/rate-pages/:slug/logo", async (req, reply) => {
    const parsed = slug.safeParse((req.params as { slug: string }).slug);
    const page = parsed.success ? (await db.select().from(schema.shopRatePages)
      .where(and(eq(schema.shopRatePages.slug, parsed.data), eq(schema.shopRatePages.live, true))).limit(1))[0] : undefined;
    const shop = page ? await liveShop(db, page.tenantId) : null;
    return sendLogo(reply, shop ? page?.logo : null, "public, max-age=300");
  });

  app.get("/api/public/screens/:token/logo", async (req, reply) => {
    const { token } = req.params as { token: string };
    const screen = /^[A-Za-z0-9_-]{32,64}$/.test(token) ? (await db.select().from(schema.windowScreens)
      .where(and(eq(schema.windowScreens.token, token), isNull(schema.windowScreens.retiredAt))).limit(1))[0] : undefined;
    const shop = screen && shownOn(screen.show).logo ? await liveShop(db, screen.tenantId) : null;
    const page = shop ? (await db.select({ logo: schema.shopRatePages.logo }).from(schema.shopRatePages).where(eq(schema.shopRatePages.tenantId, shop.id)).limit(1))[0] : undefined;
    return sendLogo(reply, page?.logo, "public, max-age=300");
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

  /* A screen link that ended up somewhere it should not: a new token, and
     the old one answers 404 from this moment. */
  app.post("/api/window-screens/:id/reset", async (req, reply) => {
    const who = await staff(req, reply, db, "rates:change");
    if (!who) return;
    const { id } = req.params as { id: string };
    const [row] = await db.update(schema.windowScreens).set({ token: newToken() })
      .where(and(eq(schema.windowScreens.id, id), eq(schema.windowScreens.tenantId, who.tenantId), isNull(schema.windowScreens.retiredAt)))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await audit(db, who, "window_screen.reset", { screenId: id });
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
