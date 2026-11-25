/* Email the Didit link. No SMS vendor. Staging mail goes only to
   @staging.invalid. A missing Didit or mail setup is 503. The audit
   stores a masked address, never the email or the link. */
import type { Db } from "../db/index.js";
import { audit } from "../audit.js";
import { isStagingRuntime } from "../auth/staging-runtime.js";
import { sendEmail } from "../email.js";
import { diditConfigured, diditSelection, diditSessionLink } from "./providers/didit.js";
import {
  agreedConsent, consentFill, dbQuery, inquiryClientId, loadShopIdv, type DeskActor, type Step,
} from "./records.js";
import { privacyReady } from "./consent-copy.js";
import { counterOnly } from "./tiers.js";

export const IDV_LINK_SUBJECT = "Your ID check link";

export function idvLinkMessage(url: string): string {
  return `Check your ID at this link:\n${url}\n\nIf you did not ask for this, you can ignore it.`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COOLDOWN_MS = 60_000;
const SHOP_MAX = 20;
const SHOP_WINDOW_MS = 60 * 60 * 1000;
const lastByClient = new Map<string, number>();
const shopHits = new Map<string, number[]>();

export function resetIdvSendLimits(): void {
  lastByClient.clear();
  shopHits.clear();
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  const domain = at > 0 ? email.slice(at + 1) : "";
  return `${local.slice(0, 1) || "•"}•••@${domain.slice(0, 1) || "•"}•••`;
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

function mailReady(env: NodeJS.ProcessEnv): boolean {
  return (env.RESEND_API_KEY ?? "").trim() !== "" && (env.EMAIL_FROM ?? "").trim() !== "";
}

function limited(shopId: string, clientId: string, now: number): boolean {
  const last = lastByClient.get(clientId) ?? 0;
  if (now - last < COOLDOWN_MS) return true;
  const hits = (shopHits.get(shopId) ?? []).filter((at) => now - at < SHOP_WINDOW_MS);
  shopHits.set(shopId, hits);
  return hits.length >= SHOP_MAX;
}

function remember(shopId: string, clientId: string, now: number): void {
  lastByClient.set(clientId, now);
  const hits = shopHits.get(shopId) ?? [];
  hits.push(now);
  shopHits.set(shopId, hits);
}

export type SendMail = (to: string, subject: string, text: string) => Promise<"sent" | "failed">;

const fail = (status: number, error: string, message: string): Step<never> => ({ ok: false, status, error, message });

export async function sendDiditLink(
  db: Db,
  actor: DeskActor,
  inquiryId: string,
  rawEmail: unknown,
  deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; mail?: SendMail; now?: () => number } = {},
): Promise<Step<{ sent: true }>> {
  const env = deps.env ?? process.env;
  const email = cleanEmail(rawEmail);
  if (!email) return fail(400, "invalid_email", "That email is not valid.");
  if (isStagingRuntime(undefined, env) && !email.endsWith("@staging.invalid")) {
    return fail(400, "invalid_email", "That email is not valid.");
  }
  const id = inquiryId.trim();
  if (!id || id.length > 80) return fail(400, "invalid_request", "That email is not valid.");
  const clientId = await inquiryClientId(db, actor, id);
  if (!clientId) return fail(404, "not_found", "That ID check is not on this client.");
  const branch = await dbQuery(db).query(
    "SELECT province FROM branches WHERE id = $1 AND legal_entity_id = $2",
    [actor.branchId, actor.legalEntityId],
  );
  const gate = counterOnly(branch.rows[0] ? String(branch.rows[0].province ?? "") : null);
  if (gate.counter) return fail(409, "COUNTER_ONLY", gate.line);
  if (!await agreedConsent(db, actor, id)) {
    return fail(409, "consent_required", "Record consent before the ID check link opens.");
  }
  const shop = await loadShopIdv(db, actor.legalEntityId);
  if (shop.provider !== "didit") return fail(409, "IDV_PROVIDER", "That identity provider is not available.");
  const tenant = await dbQuery(db).query("SELECT is_test_shop FROM tenants WHERE id = $1", [actor.tenantId]);
  const selection = diditSelection(env, tenant.rows[0]?.is_test_shop === true);
  if (!selection.ok) return fail(409, "IDV_PROVIDER", selection.message);
  if (!diditConfigured(env)) return fail(503, "not_available", "The message was not sent.");
  if (!deps.mail && !mailReady(env)) return fail(503, "not_available", "The message was not sent.");
  const fill = await consentFill(db, actor);
  if (isStagingRuntime(undefined, env) && !privacyReady(fill)) {
    return fail(409, "PRIVACY_CONTACT", "Set the shop privacy contact before a face match. The owner adds it in identity check settings.");
  }
  const now = (deps.now ?? Date.now)();
  if (limited(actor.legalEntityId, clientId, now)) {
    return fail(429, "slow_down", "Wait a moment, then send it again.");
  }
  let url = "";
  try {
    url = await diditSessionLink({ sessionId: id, env, fetchImpl: deps.fetch });
  } catch {
    return fail(502, "link_failed", "The message was not sent. Try again.");
  }
  const text = idvLinkMessage(url);
  const mail = deps.mail ?? ((to, subject, body) => sendEmail(to, subject, { text: body, sensitive: true }).then((status) => status === "sent" ? "sent" as const : "failed" as const));
  const status = await mail(email, IDV_LINK_SUBJECT, text).catch(() => "failed" as const);
  if (status !== "sent") return fail(502, "send_failed", "The message was not sent. Try again.");
  remember(actor.legalEntityId, clientId, now);
  await audit(db, {
    tenantId: actor.tenantId,
    legalEntityId: actor.legalEntityId,
    branchId: actor.branchId,
    actorId: actor.staffId,
    action: "idv.link_sent",
    detail: { channel: "email", destination: maskEmail(email), staffId: actor.staffId },
  });
  return { ok: true, body: { sent: true } };
}
