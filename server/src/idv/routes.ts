/* POST /api/webhooks/idv/:provider. Off without a signing secret.
   Signature first. Shop comes from the map, never the payload.
   Unknown reference: 200 and no write. One row per event id. */
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import type { IdvProvider } from "./provider.js";
import { createPersonaProvider } from "./providers/persona/index.js";
import { recordIdvEvent } from "./store.js";

export type IdvRouteOptions = { persona?: IdvProvider | null };

function rawBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

export function registerIdvRoutes(app: FastifyInstance, db: Db, options?: IdvRouteOptions): void {
  const persona = options && "persona" in options ? options.persona ?? null : createPersonaProvider();
  const registry: Record<string, IdvProvider | null> = { persona };
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
      return { received: true, duplicate: saved === "duplicate" };
    } catch (err) {
      req.log.error({ reason: "record_failed", name: err instanceof Error ? err.name : "Error" }, "idv webhook failed");
      return reply.code(500).send({ error: "webhook_processing_failed" });
    }
  });
}
