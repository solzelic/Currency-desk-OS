/* Per-shop identity-verification settings. The shop is the session legal
   entity. A shop id from the client is ignored. apiKeyRef stores an
   environment variable name, and a refusal is not stored or logged. */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { hasBackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { schema, type Db } from "../db/index.js";
import { defaultIdvProvider, idvProvider } from "./providers/index.js";

export const OWNER_ONLY = "Only the owner can view or change identity check settings for this shop.";
const REF_NAME = "The API key field takes an environment variable name. Do not send a key.";
const TEMPLATE = "The template id is not valid for this provider.";
const RETENTION = "Retention is a whole number of days from 1 to 3650.";
const ENABLED = "Checks enabled takes true or false.";
const UNKNOWN = "This route does not accept that field.";
const BAD_BODY = "The identity check settings could not be read.";
const PROVIDER = "That identity provider is not available.";
const REF = /^[A-Z][A-Z0-9_]{2,63}$/;
const TEMPLATE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROVIDER_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;
const KNOWN = new Set(["shopid", "provider", "apikeyref", "templateid", "retentiondays", "checksenabled"]);

export type IdvShopConfig = {
  shopId: string;
  provider: string;
  apiKeyRef: string | null;
  templateId: string | null;
  retentionDays: number | null;
  checksEnabled: boolean;
};

type Stored = Omit<IdvShopConfig, "shopId">;
type Parsed = { ok: true; value: Stored } | { ok: false; status: 400 | 422; message: string };

const reject = (status: 400 | 422, message: string): Parsed => ({ ok: false, status, message });

/* shopId is allowed and ignored. An omitted checks flag stays off. */
export function parseIdvShopConfig(body: unknown): Parsed {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return reject(400, BAD_BODY);
  const raw = body as Record<string, unknown>;
  const folded = (key: string) => key.toLowerCase().replace(/-/g, "");
  if (Object.keys(raw).some((key) => !KNOWN.has(folded(key)))) return reject(400, UNKNOWN);

  const providerId = raw.provider === undefined ? defaultIdvProvider().id : raw.provider;
  if (typeof providerId !== "string") return reject(400, PROVIDER);
  if (!PROVIDER_SHAPE.test(providerId) || !idvProvider(providerId)) return reject(422, PROVIDER);
  const provider = idvProvider(providerId)!;

  let apiKeyRef: string | null = null;
  if (raw.apiKeyRef !== undefined && raw.apiKeyRef !== null) {
    if (typeof raw.apiKeyRef !== "string" || !REF.test(raw.apiKeyRef)) return reject(400, REF_NAME);
    apiKeyRef = raw.apiKeyRef;
  }
  let templateId: string | null = null;
  if (raw.templateId !== undefined && raw.templateId !== null && raw.templateId !== "") {
    if (typeof raw.templateId !== "string") return reject(400, TEMPLATE);
    if (!TEMPLATE_SHAPE.test(raw.templateId)) return reject(422, TEMPLATE);
    templateId = raw.templateId;
  }
  const issue = provider.fieldIssue({ apiKeyRef, templateId });
  if (issue === "reference") return reject(400, REF_NAME);
  if (issue === "template") return reject(422, TEMPLATE);

  let retentionDays: number | null = null;
  if (raw.retentionDays !== undefined && raw.retentionDays !== null) {
    const days = raw.retentionDays;
    if (typeof days !== "number" || !Number.isInteger(days)) return reject(400, RETENTION);
    if (days < 1 || days > 3650) return reject(422, RETENTION);
    retentionDays = days;
  }
  if (raw.checksEnabled !== undefined && typeof raw.checksEnabled !== "boolean") return reject(400, ENABLED);
  return {
    ok: true,
    value: { provider: provider.id, apiKeyRef, templateId, retentionDays, checksEnabled: raw.checksEnabled === true },
  };
}

export function registerIdvShopConfigRoutes(app: FastifyInstance, db: Db): void {
  const load = async (shopId: string): Promise<IdvShopConfig> => {
    const row = (await db.select().from(schema.idvShopConfig).where(eq(schema.idvShopConfig.shopId, shopId)).limit(1))[0];
    return {
      shopId,
      provider: row?.provider ?? defaultIdvProvider().id,
      apiKeyRef: row?.apiKeyRef ?? null,
      templateId: row?.templateId ?? null,
      retentionDays: row?.retentionDays ?? null,
      checksEnabled: row?.checksEnabled ?? false,
    };
  };
  const owner = async (req: { cookies: Record<string, string | undefined> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" }), null;
    if (!hasBackendPermission(who.role, "compliance:thresholds")) return reply.code(403).send({ code: "AUTHORIZATION_DENIED", message: OWNER_ONLY }), null;
    return who;
  };

  app.get("/api/settings/idv", async (req, reply) => {
    const who = await owner(req, reply);
    return who ? load(who.legalEntityId) : undefined;
  });

  app.put("/api/settings/idv", async (req, reply) => {
    const who = await owner(req, reply);
    if (!who) return undefined;
    const parsed = parseIdvShopConfig(req.body);
    if (!parsed.ok) return reply.code(parsed.status).send({ code: "IDV_CONFIG_INVALID", message: parsed.message });
    await db.insert(schema.idvShopConfig).values({ shopId: who.legalEntityId, ...parsed.value }).onConflictDoUpdate({
      target: schema.idvShopConfig.shopId,
      set: parsed.value,
    });
    return { shopId: who.legalEntityId, ...parsed.value };
  });
}
