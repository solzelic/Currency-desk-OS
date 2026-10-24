/* Per-shop identity-verification settings. The shop is the session legal
   entity. A shop id from the client is ignored. The API key column stores
   a reference name. Checks default off. No other route reads this table. */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { hasBackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { schema, type Db } from "../db/index.js";
import { defaultIdvProvider, idvProvider } from "./providers/index.js";

export const OWNER_ONLY = "Only the owner can view or change identity check settings for this shop.";
const REF_NAME = "The API key field takes a reference name. Do not send a key.";
const TEMPLATE = "The template id is not valid for this provider.";
const RETENTION = "Retention is a whole number of days from 1 to 3650.";
const ENABLED = "Checks enabled takes true or false.";
const KEY_FIELD = "This route does not accept a key field.";
const BAD_BODY = "The identity check settings could not be read.";
const PROVIDER = "That identity provider is not available.";
const REF = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const TEMPLATE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROVIDER_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;
const FORBIDDEN = new Set(["apikey", "api_key", "key", "secret", "token", "webhooksecret", "webhook_secret", "password", "authorization", "bearer"]);

export type IdvShopConfig = {
  shopId: string;
  provider: string;
  apiKeyRef: string | null;
  templateId: string | null;
  retentionDays: number | null;
  checksEnabled: boolean;
};

type Stored = Omit<IdvShopConfig, "shopId">;

function referenceName(value: string): boolean {
  if (!REF.test(value)) return false;
  const lower = value.toLowerCase();
  return !lower.includes("secret") && !lower.includes("apikey") && !lower.includes("api_key") && !lower.includes("api-key");
}

function optionalText(value: unknown, ok: (item: string) => boolean, message: string) {
  if (value === undefined || value === null || value === "") return { ok: true as const, value: null };
  if (typeof value !== "string" || !ok(value)) return { ok: false as const, message };
  return { ok: true as const, value };
}

/* An omitted checks flag stays off. An omitted provider is the default. */
export function parseIdvShopConfig(body: unknown): { ok: true; value: Stored } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: BAD_BODY };
  const raw = body as Record<string, unknown>;
  const folded = (key: string) => key.toLowerCase().replace(/-/g, "");
  if (Object.keys(raw).some((key) => FORBIDDEN.has(folded(key)))) return { ok: false, message: KEY_FIELD };

  const providerId = raw.provider === undefined ? defaultIdvProvider().id : raw.provider;
  if (typeof providerId !== "string" || !PROVIDER_SHAPE.test(providerId)) return { ok: false, message: PROVIDER };
  const provider = idvProvider(providerId);
  if (!provider) return { ok: false, message: PROVIDER };

  const apiKeyRef = optionalText(raw.apiKeyRef, referenceName, REF_NAME);
  if (!apiKeyRef.ok) return apiKeyRef;
  const templateId = optionalText(raw.templateId, (item) => TEMPLATE_SHAPE.test(item), TEMPLATE);
  if (!templateId.ok) return templateId;
  const issue = provider.fieldIssue({ apiKeyRef: apiKeyRef.value, templateId: templateId.value });
  if (issue === "reference") return { ok: false, message: REF_NAME };
  if (issue === "template") return { ok: false, message: TEMPLATE };

  let retentionDays: number | null = null;
  if (raw.retentionDays !== undefined && raw.retentionDays !== null) {
    const days = raw.retentionDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) return { ok: false, message: RETENTION };
    retentionDays = days;
  }
  if (raw.checksEnabled !== undefined && typeof raw.checksEnabled !== "boolean") return { ok: false, message: ENABLED };
  return {
    ok: true,
    value: { provider: provider.id, apiKeyRef: apiKeyRef.value, templateId: templateId.value, retentionDays, checksEnabled: raw.checksEnabled === true },
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
    if (!parsed.ok) return reply.code(422).send({ code: "IDV_CONFIG_INVALID", message: parsed.message });
    await db.insert(schema.idvShopConfig).values({ shopId: who.legalEntityId, ...parsed.value }).onConflictDoUpdate({
      target: schema.idvShopConfig.shopId,
      set: parsed.value,
    });
    return { shopId: who.legalEntityId, ...parsed.value };
  });
}
