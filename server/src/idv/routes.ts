/* POST /api/webhooks/idv/:provider. Off without a signing secret.
   Signature first. Shop comes from the map, never the payload.
   Unknown reference: 200 and no write. One row per event id.
   POST /api/idv/start-check is the caller's shop, branch, and teller. */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import type { Db } from "../db/index.js";
import { reserveIdvCredit } from "./credit.js";
import type { IdvProvider } from "./provider.js";
import { startProviders, webhookProviders, type IdvRouteOptions } from "./registry.js";
import { failStarting, markInquiry, recordIdvEvent, reserveIdvSlot, setProviderRef } from "./store.js";

export const IDV_SHOP_CAP = 5;
const OFF = "Identity checks are off for this shop.";
const NOT_CONNECTED = "Identity checks are not connected.";
const CAP = "This shop already has the maximum number of identity checks in progress.";
const UNKNOWN = "That identity provider is not available.";

export type { IdvRouteOptions };

function rawBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

export function registerIdvRoutes(app: FastifyInstance, db: Db, options?: IdvRouteOptions): void {
  const registry = webhookProviders(options);
  const starts = startProviders(options);
  app.post<{ Params: { provider: string } }>("/api/webhooks/idv/:provider", { config: { rawBody: true } }, async (req, reply) => {
    if (!(req.params.provider in registry)) return reply.code(404).send({ error: "unknown_provider" });
    const provider = registry[req.params.provider];
    if (!provider) return reply.code(503).send({ error: "not_configured" });
    const raw = rawBuffer(req.rawBody);
    const headers = req.headers as Record<string, string | string[] | undefined>;
    if (!raw || !provider.verifyWebhook({ rawBody: raw, headers })) {
      return reply.code(400).send({ error: "invalid_signature" });
    }
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch { return reply.code(400).send({ error: "invalid_webhook" }); }
    const result = provider.parseResult(body);
    if (!result || result.provider !== provider.name) return reply.code(400).send({ error: "invalid_webhook" });
    try {
      const saved = await recordIdvEvent(db, result);
      if (saved === "unknown") return { received: true, dropped: true };
      await markInquiry(db, result);
      return { received: true, duplicate: saved === "duplicate" };
    } catch (err) {
      req.log.error({ reason: "record_failed", name: err instanceof Error ? err.name : "Error" }, "idv webhook failed");
      return reply.code(500).send({ error: "webhook_processing_failed" });
    }
  });

  app.post("/api/idv/start-check", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const found = await db.execute(sql`
      SELECT provider, checks_enabled FROM idv_shop_config WHERE shop_id = ${who.legalEntityId} LIMIT 1
    `);
    const row = found.rows[0] as { provider?: string; checks_enabled?: boolean } | undefined;
    if (!row || row.checks_enabled !== true) return reply.code(409).send({ code: "IDV_OFF", message: OFF });
    const id = typeof row.provider === "string" ? row.provider : "";
    if (!(id in starts)) return reply.code(409).send({ code: "IDV_PROVIDER", message: UNKNOWN });
    const provider = starts[id];
    if (!provider) return { connected: false, message: NOT_CONNECTED };
    const referenceId = randomBytes(18).toString("base64url");
    const reserved = await reserveIdvSlot(db, {
      referenceId, shopId: who.legalEntityId, branchId: who.branchId, tellerId: who.id,
      provider: provider.name, providerRef: referenceId,
    }, options?.cap ?? IDV_SHOP_CAP);
    if (!reserved) return reply.code(409).send({ code: "IDV_CAP", message: CAP });
    /* No credit ledger in this repo. Do not invent one, and do not settle. */
    reserveIdvCredit(referenceId);
    try {
      const started = await provider.startCheck({
        referenceId, shopId: who.legalEntityId, branchId: who.branchId, tellerId: who.id,
      });
      await setProviderRef(db, referenceId, started.providerRef);
      return { connected: true, referenceId, providerRef: started.providerRef };
    } catch (err) {
      await failStarting(db, referenceId);
      if (err instanceof Error && err.message === "not_connected") return { connected: false, message: NOT_CONNECTED };
      req.log.error({ reason: "start_failed", name: err instanceof Error ? err.name : "Error" }, "idv start failed");
      return reply.code(502).send({ error: "provider_unavailable" });
    }
  });
}
