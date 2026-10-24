/* Per-shop identity-verification settings. The shop is the session legal
   entity. A shop id from the client is ignored. apiKeyRef stores an
   environment variable name. A refusal is not stored or logged. */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { hasBackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { schema, type Db } from "../db/index.js";
import { defaultIdvProvider, idvProvider } from "./providers/index.js";
import { personaRefIssue } from "./providers/persona.js";

export const OWNER_ONLY = "Only the owner can view or change identity check settings for this shop.";
const KEY_VALUE = "Put an environment variable name, not a key.";
const BAD_NAME = "The API key field takes an environment variable name for this shop.";
const TEMPLATE = "The template id is not valid for this provider.";
const RETENTION = "Retention is a whole number of days from 1 to 3650.";
const ENABLED = "Checks enabled takes true or false.";
const UNKNOWN = "This route does not accept that field.";
const BAD_BODY = "The identity check settings could not be read.";
const PROVIDER = "That identity provider is not available.";
const TEMPLATE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROVIDER_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;
const KNOWN = new Set(["shopid", "provider", "apikeyref", "templateid", "retentiondays", "checksenabled"]);

/* Site handle, otherwise the shop name. Capitals, digits, and underscores. */
export function shopEnvCode(source: { siteSlug?: string | null; name?: string | null }): string {
  const slug = source.siteSlug?.trim() ?? "";
  const code = (slug || source.name || "").toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z0-9_]+$/.test(code) ? code : "";
}

export async function shopEnvCodeFor(db: Db, tenantId: string): Promise<string> {
  const row = (await db.select({ siteSlug: schema.tenants.siteSlug, name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];
  return shopEnvCode(row ?? {});
}

export type IdvShopConfig = {
  shopId: string;
  provider: string;
  apiKeyRef: string | null;
  templateId: string | null;
  retentionDays: number | null;
  checksEnabled: boolean;
};

type Stored = Omit<IdvShopConfig, "shopId">;
type Patch = {
  provider?: string;
  apiKeyRef?: string | null;
  templateId?: string | null;
  retentionDays?: number | null;
  checksEnabled?: boolean;
};
type Parsed = { ok: true; patch: Patch } | { ok: false; status: 400 | 422; message: string };

const reject = (status: 400 | 422, message: string): Parsed => ({ ok: false, status, message });

/* shopId is allowed and ignored. A field left out stays unchanged.
   Null clears the key name, the template, and the retention. */
export function parseIdvShopConfig(body: unknown, shopCode: string): Parsed {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return reject(400, BAD_BODY);
  const raw = body as Record<string, unknown>;
  const folded = (key: string) => key.toLowerCase().replace(/-/g, "");
  if (Object.keys(raw).some((key) => !KNOWN.has(folded(key)))) return reject(400, UNKNOWN);
  const patch: Patch = {};

  if ("provider" in raw) {
    if (typeof raw.provider !== "string") return reject(400, PROVIDER);
    if (!PROVIDER_SHAPE.test(raw.provider) || !idvProvider(raw.provider)) return reject(422, PROVIDER);
    patch.provider = idvProvider(raw.provider)!.id;
  }
  const provider = idvProvider(patch.provider ?? defaultIdvProvider().id)!;

  if ("apiKeyRef" in raw) {
    if (raw.apiKeyRef === null) patch.apiKeyRef = null;
    else if (typeof raw.apiKeyRef !== "string") return reject(400, BAD_NAME);
    else {
      const kind = personaRefIssue(raw.apiKeyRef, shopCode);
      if (kind === "key") return reject(400, KEY_VALUE);
      if (kind === "name") return reject(400, BAD_NAME);
      patch.apiKeyRef = raw.apiKeyRef;
    }
  }
  if ("templateId" in raw) {
    if (raw.templateId === null || raw.templateId === "") patch.templateId = null;
    else if (typeof raw.templateId !== "string") return reject(400, TEMPLATE);
    else if (!TEMPLATE_SHAPE.test(raw.templateId)) return reject(422, TEMPLATE);
    else if (provider.fieldIssue({ apiKeyRef: null, templateId: raw.templateId, shopCode }) === "template") return reject(422, TEMPLATE);
    else patch.templateId = raw.templateId;
  }
  if ("retentionDays" in raw) {
    if (raw.retentionDays === null) patch.retentionDays = null;
    else if (typeof raw.retentionDays !== "number" || !Number.isInteger(raw.retentionDays)) return reject(400, RETENTION);
    else if (raw.retentionDays < 1 || raw.retentionDays > 3650) return reject(422, RETENTION);
    else patch.retentionDays = raw.retentionDays;
  }
  if ("checksEnabled" in raw) {
    if (typeof raw.checksEnabled !== "boolean") return reject(400, ENABLED);
    patch.checksEnabled = raw.checksEnabled;
  }
  return { ok: true, patch };
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
    const parsed = parseIdvShopConfig(req.body, await shopEnvCodeFor(db, who.tenantId));
    if (!parsed.ok) return reply.code(parsed.status).send({ code: "IDV_CONFIG_INVALID", message: parsed.message });
    const current = await load(who.legalEntityId);
    const next: Stored = {
      provider: parsed.patch.provider ?? current.provider,
      apiKeyRef: parsed.patch.apiKeyRef !== undefined ? parsed.patch.apiKeyRef : current.apiKeyRef,
      templateId: parsed.patch.templateId !== undefined ? parsed.patch.templateId : current.templateId,
      retentionDays: parsed.patch.retentionDays !== undefined ? parsed.patch.retentionDays : current.retentionDays,
      checksEnabled: parsed.patch.checksEnabled !== undefined ? parsed.patch.checksEnabled : current.checksEnabled,
    };
    await db.insert(schema.idvShopConfig).values({ shopId: who.legalEntityId, ...next }).onConflictDoUpdate({
      target: schema.idvShopConfig.shopId,
      set: next,
    });
    return { shopId: who.legalEntityId, ...next };
  });
}
