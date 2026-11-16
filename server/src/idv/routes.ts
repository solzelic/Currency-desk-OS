/* POST /api/webhooks/idv/:provider. Off without a signing secret.
   Signature first. Shop and tenant come from the stored inquiry, never the payload.
   Unknown inquiry id: 200 and no write. A reference id that disagrees is 400.
   One row per event id.
   POST /api/idv/start-check is the caller's shop, branch, and teller. */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { hasBackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import type { Db } from "../db/index.js";
import { reserveIdvCredit } from "./credit.js";
import type { IdvProvider } from "./provider.js";
import { startProviders, webhookProviders, type IdvRouteOptions } from "./registry.js";
import { personaConnection, personaKeyMatchesRuntime, personaPassLabel } from "./providers/persona.js";
import { shopEnvCodeFor } from "./shop-config.js";
import { clientOnShop, failStarting, latestClientIdvStatus, reserveIdvSlot, setProviderRef } from "./store.js";
import { finishIdvWebhook } from "./webhook-record.js";
import { loadShopIdv, templateForTier } from "./records.js";
import { counterOnly, faceMatchTier, resolveTier } from "./tiers.js";

export const IDV_SHOP_CAP = 5;
export const IDV_WEBHOOK_BODY_LIMIT = 256 * 1024;
const CLIENT_ID_MAX = 80;
const STARTS_PER_MINUTE = 10;
const startsByShop = new Map<string, number[]>();
const OFF = "Identity checks are off for this shop.";
const NOT_CONNECTED = "Identity checks are not connected.";
const CAP = "This shop already has the maximum number of identity checks in progress.";
const UNKNOWN = "That identity provider is not available.";
const FORBIDDEN = "You cannot start an identity check.";
const BAD_CLIENT = "That client id is not valid.";
const KEY_MISMATCH = "This shop's identity key does not match this server.";
const RATE = "Too many identity checks were started. Wait a minute and try again.";
const UNAVAILABLE = "The identity check could not be started. Nothing from the provider was saved.";

export function allowIdvStart(
  shopId: string,
  now = Date.now(),
  limit = STARTS_PER_MINUTE,
  store: Map<string, number[]> = startsByShop,
): boolean {
  const recent = (store.get(shopId) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= limit) {
    store.set(shopId, recent);
    return false;
  }
  recent.push(now);
  store.set(shopId, recent);
  return true;
}

export type { IdvRouteOptions };

function rawBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

export function registerIdvRoutes(app: FastifyInstance, db: Db, options?: IdvRouteOptions): void {
  const registry = webhookProviders(options);
  const starts = startProviders(options);
  app.post<{ Params: { provider: string } }>("/api/webhooks/idv/:provider", { bodyLimit: IDV_WEBHOOK_BODY_LIMIT, config: { rawBody: true } }, async (req, reply) => {
    if (!(req.params.provider in registry)) return reply.code(404).send({ error: "unknown_provider" });
    const provider = registry[req.params.provider];
    if (!provider) return reply.code(503).send({ error: "not_configured" });
    const raw = rawBuffer(req.rawBody);
    const headers = req.headers as Record<string, string | string[] | undefined>;
    if (!raw || !provider.verifyWebhook({ rawBody: raw, headers })) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch { return reply.code(400).send({ error: "invalid_webhook" }); }
    const result = provider.parseResult(body);
    if (!result || result.provider !== provider.name) return reply.code(400).send({ error: "invalid_webhook" });
    if (result.ignore) return { received: true, dropped: true };
    try {
      const saved = await finishIdvWebhook(db, result, { env: options?.env ?? process.env, fetchImpl: options?.fetch });
      if (saved === "unknown") return { received: true, dropped: true };
      if (saved === "conflict") return reply.code(400).send({ error: "invalid_webhook" });
      if (saved === "duplicate") return { received: true, duplicate: true };
      return { received: true, duplicate: false };
    } catch (err) {
      req.log.error({ reason: "record_failed", name: err instanceof Error ? err.name : "Error" }, "idv webhook failed");
      return reply.code(500).send({ error: "webhook_processing_failed" });
    }
  });

  app.post("/api/idv/start-check", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (!hasBackendPermission(who.role, "customer:write")) return reply.code(403).send({ error: "forbidden", message: FORBIDDEN });
    const rawBody = req.body;
    const namedClient = typeof rawBody === "object" && rawBody !== null && "clientId" in rawBody;
    const clientValue = namedClient ? (rawBody as { clientId?: unknown }).clientId : undefined;
    if (namedClient && typeof clientValue !== "string") return reply.code(400).send({ error: "invalid_client", message: BAD_CLIENT });
    const clientId = typeof clientValue === "string" ? clientValue.trim() : "";
    if (clientId.length > CLIENT_ID_MAX) return reply.code(400).send({ error: "invalid_client", message: BAD_CLIENT });
    const tierRaw = typeof rawBody === "object" && rawBody !== null && "tier" in rawBody ? (rawBody as { tier?: unknown }).tier : undefined;
    const tier = typeof tierRaw === "string" ? resolveTier(tierRaw.trim()) : null;
    if (typeof tierRaw === "string" && !tier) return reply.code(400).send({ error: "invalid_request", message: "That ID check tier is not valid." });
    if (tier === "1") return reply.code(409).send({ code: "COUNTER_PATH", message: "In person is recorded at the counter. No identity provider is called." });
    if (tier === "2") return reply.code(409).send({ code: "RETURNING", message: "Returning client does not start an identity provider check." });
    const shop = await loadShopIdv(db, who.legalEntityId);
    const province = await db.execute(sql`SELECT province FROM branches WHERE id = ${who.branchId} AND legal_entity_id = ${who.legalEntityId} LIMIT 1`);
    const gate = counterOnly((province.rows[0] as { province?: string | null } | undefined)?.province ?? null);
    const gateTier = tier ?? "3";
    if (gate.quebec || (faceMatchTier(gateTier) && gate.counter)) {
      return reply.code(409).send({ code: "COUNTER_ONLY", message: gate.line });
    }
    const found = await db.execute(sql`
      SELECT provider, checks_enabled, api_key_ref, template_id
        FROM idv_shop_config WHERE shop_id = ${who.legalEntityId} LIMIT 1
    `);
    const row = found.rows[0] as {
      provider?: string; checks_enabled?: boolean; api_key_ref?: string | null; template_id?: string | null;
    } | undefined;
    if (!row || row.checks_enabled !== true) return reply.code(409).send({ code: "IDV_OFF", message: OFF });
    const id = typeof row.provider === "string" ? row.provider : "";
    if (!(id in starts)) return reply.code(409).send({ code: "IDV_PROVIDER", message: UNKNOWN });
    const provider = starts[id];
    if (!provider) return { connected: false, message: NOT_CONNECTED };
    const spec = {
      referenceId: "", shopId: who.legalEntityId, branchId: who.branchId, tellerId: who.id,
      apiKeyRef: row.api_key_ref ?? null,
      templateId: templateForTier(shop, tier) ?? row.template_id ?? null,
      shopCode: await shopEnvCodeFor(db, who.tenantId),
    };
    if (provider.ready && !provider.ready(spec)) return { connected: false, message: NOT_CONNECTED };
    const env = options?.env ?? process.env;
    const creds = personaConnection(spec, env);
    if (creds && !personaKeyMatchesRuntime(creds.apiKey, env)) {
      return reply.code(409).send({ code: "IDV_KEY", message: KEY_MISMATCH });
    }
    if (clientId && !await clientOnShop(db, who.legalEntityId, who.tenantId, clientId, options?.clients)) {
      return reply.code(404).send({ error: "not_found", message: "That client is not on this shop." });
    }
    if (!allowIdvStart(who.legalEntityId, Date.now(), options?.ratePerMinute ?? STARTS_PER_MINUTE, options?.rateLimitStore)) {
      return reply.code(429).send({ code: "IDV_RATE", message: RATE });
    }
    const referenceId = randomBytes(18).toString("base64url");
    const reserved = await reserveIdvSlot(db, {
      referenceId, shopId: who.legalEntityId, branchId: who.branchId, tellerId: who.id,
      provider: provider.name, providerRef: referenceId, clientId: clientId || null,
    }, options?.cap ?? IDV_SHOP_CAP);
    if (reserved.kind === "capped") return reply.code(409).send({ code: "IDV_CAP", message: CAP });
    const activeId = reserved.referenceId;
    const tierFields = tier === "4"
      ? { tier: "4" as const, databaseStep: "off" as const, message: "The database step is not on yet. This check runs ID and selfie." }
      : tier === "3"
        ? { tier: "3" as const, method: "ID and selfie" }
        : {};
    if (tier) {
      await db.execute(sql`UPDATE idv_inquiries SET requested_tier = ${tier} WHERE reference_id = ${activeId}`);
    }
    if (reserved.kind === "reused" && reserved.providerRef !== reserved.referenceId) {
      return { connected: true, referenceId: activeId, providerRef: reserved.providerRef, reused: true, ...tierFields };
    }
    /* No credit ledger in this repo. Do not invent one, and do not settle. */
    reserveIdvCredit(activeId);
    try {
      const started = await provider.startCheck({ ...spec, referenceId: activeId });
      await setProviderRef(db, activeId, started.providerRef);
      if (reserved.kind === "created") {
        await audit(db, {
          tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id,
          action: "idv.check_started",
          detail: { referenceId: activeId, clientId: clientId || null, provider: provider.name },
        });
      }
      return {
        connected: true, referenceId: activeId, providerRef: started.providerRef, reused: reserved.kind === "reused",
        ...tierFields,
      };
    } catch (err) {
      await failStarting(db, activeId);
      if (err instanceof Error && err.message === "not_connected") return { connected: false, message: NOT_CONNECTED };
      req.log.error({ reason: "start_failed", name: err instanceof Error ? err.name : "Error" }, "idv start failed");
      return reply.code(502).send({ error: "provider_unavailable", message: UNAVAILABLE });
    }
  });

  app.get<{ Params: { clientId: string } }>("/api/idv/clients/:clientId", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const clientId = req.params.clientId.trim();
    if (clientId.length > CLIENT_ID_MAX) return reply.code(400).send({ error: "invalid_client", message: BAD_CLIENT });
    if (!clientId || !await clientOnShop(db, who.legalEntityId, who.tenantId, clientId, options?.clients)) {
      return reply.code(404).send({ error: "not_found", message: "That client is not on this shop." });
    }
    const config = await db.execute(sql`
      SELECT checks_enabled, api_key_ref FROM idv_shop_config WHERE shop_id = ${who.legalEntityId} LIMIT 1
    `);
    const configRow = config.rows[0] as { checks_enabled?: boolean; api_key_ref?: string | null } | undefined;
    const checksEnabled = configRow?.checks_enabled === true;
    const stored = await latestClientIdvStatus(db, who.legalEntityId, clientId);
    if (stored !== "approved") return { status: stored, checksEnabled };
    const shopCode = await shopEnvCodeFor(db, who.tenantId);
    const status = personaPassLabel(options?.env ?? process.env, configRow?.api_key_ref ?? null, shopCode);
    return { status, checksEnabled };
  });
}
