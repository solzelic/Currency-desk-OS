/* Persona door. The status route is what the desk reads.
   The webhook is what Persona calls. Neither runs unless both secrets
   are set, and neither logs the body. */
import type { FastifyInstance } from "fastify";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import type { Db } from "../db/index.js";
import { recordPersonaEvent } from "../kyc/record.js";
import { PERSONA_DISCONNECTED, parsePersonaEvent, personaConfig, verifyPersonaSignature } from "../kyc/persona.js";

export function registerKycRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/kyc/persona", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const config = personaConfig();
    if (!config) return { connected: false, message: PERSONA_DISCONNECTED };
    return { connected: true, environment: config.environment };
  });

  app.post("/api/webhooks/persona", { config: { rawBody: true } }, async (req, reply) => {
    const config = personaConfig();
    if (!config) return reply.code(503).send({ error: "not_connected", message: PERSONA_DISCONNECTED });
    const raw = rawBuffer(req.rawBody);
    const signature = headerOne(req.headers["persona-signature"]);
    if (!raw || !signature || !verifyPersonaSignature({ rawBody: raw, signature, secret: config.webhookSecret })) {
      req.log.warn({ reason: "invalid_signature" }, "persona webhook rejected");
      return reply.code(400).send({ error: "invalid_signature" });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      req.log.warn({ reason: "invalid_json", name }, "persona webhook rejected");
      return reply.code(400).send({ error: "invalid_webhook" });
    }
    const event = parsePersonaEvent(body);
    if (event === null) {
      req.log.warn({ reason: "invalid_event" }, "persona webhook rejected");
      return reply.code(400).send({ error: "invalid_webhook" });
    }
    if (event === "ignore") return { received: true, ignored: true };
    try {
      const outcome = await recordPersonaEvent(db, event, config.environment);
      return { received: true, duplicate: outcome === "duplicate" };
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      req.log.error({ reason: "record_failed", name, eventId: event.eventId }, "persona webhook failed");
      return reply.code(500).send({ error: "webhook_processing_failed" });
    }
  });
}

function rawBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

function headerOne(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0]) return value[0];
  return null;
}
