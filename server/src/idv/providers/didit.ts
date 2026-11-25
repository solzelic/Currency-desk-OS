/* Didit adapter. API v3, sandbox until DIDIT_LIVE_ALLOWED is exactly 1.
   Create: POST https://verification.didit.me/v3/session/ with x-api-key
   and workflow_id. Decision: GET /v3/session/{session_id}/decision/.
   Webhook v3: HMAC-SHA256 over the raw body (X-Signature), or the
   canonical JSON form (X-Signature-V2). Timestamp window is 300 seconds.
   https://docs.didit.me/sessions-api/create-session
   https://docs.didit.me/sessions-api/retrieve-session
   https://docs.didit.me/integration/webhooks
   https://docs.didit.me/integration/verification-statuses
   The key, the signing secret, and the raw body are never logged. */
import * as crypto from "node:crypto";
import { isStagingRuntime } from "../../auth/staging-runtime.js";
import type { IdvOutcome, IdvProvider, IdvResult, IdvSettingsProvider, IdvStart, IdvWebhookInput } from "../provider.js";

const WINDOW_SEC = 300;
const DIDIT_FETCH_MS = 10_000;
const ATTEMPTS = 3;
export const DIDIT_API_BASE_DEFAULT = "https://verification.didit.me";
export const DIDIT_HOST = "verify.didit.me";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

const STATUS: Record<string, { outcome: IdvOutcome; inquiryStatus?: "in progress" | "needs review" }> = {
  "Not Started": { outcome: "pending", inquiryStatus: "in progress" },
  "In Progress": { outcome: "pending", inquiryStatus: "in progress" },
  "Awaiting User": { outcome: "pending", inquiryStatus: "in progress" },
  Resubmitted: { outcome: "pending", inquiryStatus: "in progress" },
  Approved: { outcome: "approved" },
  Declined: { outcome: "declined" },
  "In Review": { outcome: "review", inquiryStatus: "needs review" },
  Abandoned: { outcome: "failed" },
  Expired: { outcome: "expired" },
  "Kyc Expired": { outcome: "expired" },
};

const HANDLED = new Set(["status.updated", "data.updated"]);

export type DiditCharge = "no_charge" | "unbilled";

/* A failed, abandoned, or declined scan is not billed. A pass is not
   billed in this sandbox slice either. Nothing here calls settle. */
export function chargeForDiditOutcome(outcome: IdvOutcome): DiditCharge {
  return outcome === "approved" ? "unbilled" : "no_charge";
}

export function diditLiveAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.DIDIT_LIVE_ALLOWED === "1";
}

/* Live Render sets RENDER=true and an onrender.com hostname, which is not
   one of the custom live hosts. Off Render, or on staging, Didit may run.
   On live Render it runs only when DIDIT_LIVE_ALLOWED is exactly 1.
   Off Render means RENDER is not exactly "true". A process that leaves
   RENDER unset is off Render. Render itself sets RENDER=true. */
export function diditRuntimeAllowed(env: NodeJS.ProcessEnv): boolean {
  return diditLiveAllowed(env) || env.RENDER !== "true" || isStagingRuntime(undefined, env);
}

/* Off Render means RENDER is not exactly "true". */
function diditOffRenderOrStaging(env: NodeJS.ProcessEnv): boolean {
  return env.RENDER !== "true" || isStagingRuntime(undefined, env);
}

export function diditSelection(
  env: NodeJS.ProcessEnv,
  testShop: boolean,
): { ok: true } | { ok: false; message: string } {
  if (!diditRuntimeAllowed(env)) {
    return { ok: false, message: "Didit is not available on this server." };
  }
  if (!testShop) {
    return { ok: false, message: "Didit can be used only on a staging test shop." };
  }
  return { ok: true };
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

export function diditConfigured(env: NodeJS.ProcessEnv): boolean {
  return trimmed(env, "DIDIT_API_KEY") !== ""
    && trimmed(env, "DIDIT_WEBHOOK_SECRET") !== ""
    && UUID.test(trimmed(env, "DIDIT_WORKFLOW_ID"));
}

/* Document-only workflow. OCR / ID verification. Not the Basic KYC workflow.
   An empty or non-UUID value means the counter scan is not available. */
export function diditDocWorkflow(
  env: NodeJS.ProcessEnv,
): { ok: true; workflowId: string } | { ok: false; reason: "not_available" } {
  const id = trimmed(env, "DIDIT_DOC_WORKFLOW_ID");
  if (!UUID.test(id)) return { ok: false, reason: "not_available" };
  return { ok: true, workflowId: id };
}

export function diditDocScanAvailable(env: NodeJS.ProcessEnv): boolean {
  return diditDocWorkflow(env).ok;
}

/* Tier 4 is off in this slice. DIDIT_AML_WORKFLOW_ID is not read. */
export function diditWorkflowForTier(
  tier: string | null | undefined,
  env: NodeJS.ProcessEnv,
): { ok: true; workflowId: string } | { ok: false; reason: "not_available" | "tier_unavailable" } {
  if (!diditConfigured(env)) return { ok: false, reason: "not_available" };
  if (tier === "1" || tier === "2" || tier === "4") return { ok: false, reason: "tier_unavailable" };
  return { ok: true, workflowId: trimmed(env, "DIDIT_WORKFLOW_ID") };
}

const FEATURE_PASS = "Approved";

function featureStatuses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const status = obj(item).status;
    return typeof status === "string" ? status : "";
  });
}

function featurePassed(statuses: string[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status === FEATURE_PASS);
}

function featureReport(decision: unknown): { id: boolean; liveness: boolean; face: boolean } {
  const record = obj(decision);
  return {
    id: featurePassed(featureStatuses(record.id_verifications)),
    liveness: featurePassed(featureStatuses(record.liveness_checks)),
    face: featurePassed(featureStatuses(record.face_matches)),
  };
}

/* Status words only. Names, numbers, and images stay in the decision.
   The default call is ID, liveness, and face match. A counter ID scan
   looks at the ID feature only and does not call the others passed. */
export function diditDecisionChecks(decision: unknown, method?: string): { passed: boolean; line: string } {
  const { id, liveness, face } = featureReport(decision);
  const word = (ok: boolean) => ok ? "passed" : "not passed";
  if (method === "counter_id_scan") return { passed: id, line: `ID ${word(id)}` };
  return {
    passed: id && liveness && face,
    line: `ID ${word(id)}, liveness ${word(liveness)}, face match ${word(face)}`,
  };
}

export function diditIdPassed(decision: unknown): boolean {
  return featureReport(decision).id;
}

/* An env-shaped name is allowed. A raw secret is not stored. */
export function diditRefIssue(name: string): "key" | null {
  return ENV_NAME.test(name) ? null : "key";
}

/* The public base is https, with no userinfo and port 443 or none.
   A loopback URL is only for a local stub, and only off Render or on staging. */
function publicDiditOrigin(url: URL): string | null {
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (url.hostname.toLowerCase() !== "verification.didit.me") return null;
  return url.origin;
}

export function diditApiBase(env: NodeJS.ProcessEnv): string {
  const raw = trimmed(env, "DIDIT_API_BASE");
  if (!raw) return DIDIT_API_BASE_DEFAULT;
  try {
    const url = new URL(raw);
    const official = publicDiditOrigin(url);
    if (official) return official;
    const host = url.hostname.toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost";
    if (url.username || url.password) return DIDIT_API_BASE_DEFAULT;
    if (loopback && diditOffRenderOrStaging(env) && (url.protocol === "http:" || url.protocol === "https:")) {
      return `${url.protocol}//${url.host}`;
    }
  } catch {
    /* fall through */
  }
  return DIDIT_API_BASE_DEFAULT;
}

export function diditHostedLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.port !== "" && url.port !== "443") return false;
    return url.hostname.toLowerCase() === DIDIT_HOST;
  } catch {
    return false;
  }
}

function header(headers: IdvWebhookInput["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value.trim();
  return Array.isArray(value) && typeof value[0] === "string" ? value[0].trim() : "";
}

function macEqual(expected: Buffer, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function shortenFloats(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(shortenFloats);
  if (data !== null && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) out[key] = shortenFloats(value);
    return out;
  }
  if (typeof data === "number" && Number.isFinite(data) && !Number.isInteger(data) && data % 1 === 0) return Math.trunc(data);
  return data;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

function verify(input: IdvWebhookInput, secret: string): boolean {
  if (!secret) return false;
  const timestamp = header(input.headers, "x-timestamp");
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > WINDOW_SEC) return false;
  const rawMac = crypto.createHmac("sha256", secret).update(input.rawBody).digest();
  const rawHeader = header(input.headers, "x-signature");
  if (rawHeader && macEqual(rawMac, rawHeader)) return true;
  const v2Header = header(input.headers, "x-signature-v2");
  if (!v2Header) return false;
  try {
    const parsed = JSON.parse(input.rawBody.toString("utf8")) as unknown;
    const canonical = JSON.stringify(sortKeys(shortenFloats(parsed)));
    const v2 = crypto.createHmac("sha256", secret).update(canonical, "utf8").digest();
    return macEqual(v2, v2Header);
  } catch {
    return false;
  }
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseDiditWebhook(body: unknown): IdvResult | null {
  const record = obj(body);
  const type = typeof record.webhook_type === "string" ? record.webhook_type : "";
  if (!HANDLED.has(type)) {
    return {
      eventId: type || "didit",
      provider: "didit",
      providerRef: "ignored",
      referenceId: "",
      outcome: "unknown",
      ignore: true,
    };
  }
  const sessionId = typeof record.session_id === "string" ? record.session_id.trim() : "";
  const status = typeof record.status === "string" ? record.status : "";
  const named = STATUS[status];
  if (!UUID.test(sessionId) || !named) return null;
  const referenceId = typeof record.vendor_data === "string" ? record.vendor_data : "";
  const checks = diditDecisionChecks(record.decision);
  return {
    eventId: `didit:${sessionId}:${status}`,
    provider: "didit",
    providerRef: sessionId,
    referenceId,
    outcome: named.outcome,
    checksPassed: checks.passed,
    checksLine: checks.line,
    idPassed: diditIdPassed(record.decision),
    ...(named.inquiryStatus ? { inquiryStatus: named.inquiryStatus } : {}),
  };
}

async function readJson(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}

export async function startDiditCheck(
  input: IdvStart,
  deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ providerRef: string }> {
  const env = deps.env ?? process.env;
  const tier = input.tier ?? "3";
  if (tier === "1" || tier === "2" || tier === "4") throw new Error("tier_unavailable");
  const method = input.method === "counter_id_scan" ? "counter_id_scan" : input.method === "counter_full" ? "counter_full" : "id_and_selfie";
  let workflowId = "";
  if (method === "counter_id_scan") {
    const doc = diditDocWorkflow(env);
    if (!doc.ok) throw new Error("doc_workflow_unset");
    workflowId = doc.workflowId;
  } else {
    const choice = diditWorkflowForTier(tier, env);
    if (!choice.ok) throw new Error(choice.reason === "tier_unavailable" ? "tier_unavailable" : "not_available");
    workflowId = choice.workflowId;
  }
  const key = trimmed(env, "DIDIT_API_KEY");
  const base = diditApiBase(env);
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify({ workflow_id: workflowId, vendor_data: input.referenceId });
  let status = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const res = await fetchImpl(`${base}/v3/session/`, {
      method: "POST",
      headers: { "x-api-key": key, accept: "application/json", "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DIDIT_FETCH_MS),
    });
    status = res.status;
    if (status === 200 || status === 201) {
      const payload = obj(await readJson(res));
      const providerRef = typeof payload.session_id === "string" ? payload.session_id : "";
      if (!UUID.test(providerRef)) throw new Error("provider_ref_missing");
      return { providerRef };
    }
    await res.body?.cancel();
    if ((status !== 429 && status < 500) || attempt === ATTEMPTS) break;
    await sleep(25 * 2 ** (attempt - 1));
  }
  throw new Error(status === 429 || status >= 500 ? "provider_unavailable" : `provider_rejected_${status}`);
}

export async function diditSessionLink(input: {
  sessionId: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!UUID.test(input.sessionId) || !diditConfigured(input.env)) throw new Error("link_failed");
  const base = diditApiBase(input.env);
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base}/v3/session/${encodeURIComponent(input.sessionId)}/decision/`, {
    method: "GET",
    headers: { "x-api-key": trimmed(input.env, "DIDIT_API_KEY"), accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(DIDIT_FETCH_MS),
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error("link_failed");
  }
  const payload = obj(await readJson(res));
  const url = typeof payload.session_url === "string" ? payload.session_url : typeof payload.url === "string" ? payload.url : "";
  if (!diditHostedLink(url)) throw new Error("link_refused");
  return url.trim();
}

export function createDiditProvider(
  env?: NodeJS.ProcessEnv,
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): IdvProvider | null {
  const source = env ?? process.env;
  if (!diditConfigured(source)) return null;
  if (!diditRuntimeAllowed(source)) return null;
  const secret = trimmed(source, "DIDIT_WEBHOOK_SECRET");
  return {
    name: "didit",
    ready() { return diditConfigured(source); },
    startCheck(input) { return startDiditCheck(input, { env: source, fetch: deps.fetch, sleep: deps.sleep }); },
    verifyWebhook(input) { return verify(input, secret); },
    parseResult: parseDiditWebhook,
  };
}

export const diditSettings: IdvSettingsProvider = {
  id: "didit",
  fieldIssue(input) {
    if (input.apiKeyRef && diditRefIssue(input.apiKeyRef) === "key") return "reference";
    return null;
  },
};
