/* Error tracking is off until SENTRY_DSN is set.
   Importing this module does not load the SDK. startErrorTracking()
   does, and only when the variable is present. With it unset, boot
   does not install a handler and does not open a network client.

   @sentry/node is pinned exactly in server/package.json (standards
   §6.5). The reason is stated there: a caret would change what is
   sent, and what this file strips, without a review.

   Default SDK integrations are not enabled. They attach request
   bodies, cookies, local variables, and HTTP spans — the data this
   file exists to keep out. v11's setupFastifyErrorHandler is a no-op;
   fastifyIntegration traces every hook. 5xx responses are captured
   from an onError hook, which leaves Fastify's own error reply alone. */
import type { Event } from "@sentry/node";
import type { FastifyInstance } from "fastify";

type SentryModule = typeof import("@sentry/node");
type TransportFactory = (options: Parameters<SentryModule["createTransport"]>[0]) => ReturnType<SentryModule["createTransport"]>;

const HEADER_DROP = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
const KEY_DROP = new Set([
  "data", "body", "cookies", "cookie", "authorization", "password", "passwd",
  "customername", "customer_name", "name", "idnumber", "id_number", "amount",
  "email", "phone", "address", "passport", "sin", "ssn", "token", "secret",
  "set-cookie", "x-api-key",
]);

let started = false;
let transportForTests: TransportFactory | undefined;

/** Vitest installs this before the first init. Production never calls it. */
export function useTestTransport(factory: TransportFactory): void {
  if (process.env.NODE_ENV !== "test") throw new Error("a test transport is refused outside tests");
  transportForTests = factory;
}

export function errorTrackingEnabled(): boolean {
  return started && Boolean(process.env.SENTRY_DSN?.trim());
}

/** Process-level handlers are skipped under vitest so a test cannot
    exit the runner. Production and local dev still capture both. */
export function sentryIntegrations(nodeEnv: string | undefined, sentry: SentryModule) {
  if (nodeEnv === "test") return [];
  return [sentry.onUncaughtExceptionIntegration(), sentry.onUnhandledRejectionIntegration()];
}

function commitSha(): string | undefined {
  const raw = process.env.RENDER_GIT_COMMIT?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/i.test(raw) ? raw : undefined;
}

function environmentName(): string {
  const named = process.env.SENTRY_ENVIRONMENT?.trim() ?? "";
  if (/^[a-z0-9-]{1,32}$/i.test(named)) return named;
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
    return process.env.NODE_ENV;
  }
  return "development";
}

function scrubStructure(event: Event): Event {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.spans;
  event.extra = dropKeys(event.extra);
  event.contexts = dropKeys(event.contexts) as Event["contexts"];
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) delete frame.vars;
  }
  return event;
}

function dropKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => dropKeys(item)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (KEY_DROP.has(key.toLowerCase())) continue;
    out[key] = dropKeys(item);
  }
  return out as T;
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 3) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function scrubEvent(event: Event, secrets: string[]): Event | null {
  const structured = scrubStructure(event);
  if (secrets.length === 0) return structured;
  try {
    return JSON.parse(redact(JSON.stringify(structured), secrets)) as Event;
  } catch (error) {
    // Drop the event. Sending the unscrubbed original would ship the
    // name, id, or amount the redaction was trying to remove.
    console.error(JSON.stringify({ event: "sentry-scrub-failed", name: error instanceof Error ? error.name : "Error" }));
    return null;
  }
}

function pushString(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (value.length >= 3) into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushString(item, into);
  }
}

function walkSecrets(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    pushString(value, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkSecrets(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) walkSecrets(item, into);
  }
}

export function secretsFromRequest(request: { headers: Record<string, unknown>; body?: unknown; query?: unknown }): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(request.headers)) {
    if (HEADER_DROP.test(key)) pushString(value, secrets);
  }
  walkSecrets(request.body, secrets);
  walkSecrets(request.query, secrets);
  return secrets;
}

export async function startErrorTracking(): Promise<void> {
  if (started || !process.env.SENTRY_DSN?.trim()) return;
  try {
    const sentry = await import("@sentry/node");
    const release = commitSha();
    const environment = environmentName();
    sentry.init({
      dsn: process.env.SENTRY_DSN.trim(),
      environment,
      release,
      // v11 collects bodies, cookies, and headers unless this says not to.
      // The hook below also deletes them, so a later integration cannot put them back.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
        frameContextLines: 0,
        databaseQueryData: false,
      },
      includeServerName: false,
      maxBreadcrumbs: 0,
      includeLocalVariables: false,
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      defaultIntegrations: false,
      integrations: sentryIntegrations(process.env.NODE_ENV, sentry),
      // Only a test supplies this. Omitting it leaves the SDK's HTTP transport.
      ...(transportForTests ? { transport: transportForTests } : {}),
      beforeSend(event) {
        // ErrorEvent is the error-shaped Event. The scrubber walks both.
        return scrubEvent(event, []) as typeof event | null;
      },
    });
    sentry.getCurrentScope().setTag("environment", environment);
    if (release) sentry.getCurrentScope().setTag("release", release);
    started = true;
  } catch (error) {
    console.error(JSON.stringify({ event: "sentry-init-failed", name: error instanceof Error ? error.name : "Error" }));
  }
}

function statusOf(error: unknown, reply: { statusCode: number }): number {
  if (error && typeof error === "object") {
    const record = error as { status?: number; statusCode?: number };
    if (typeof record.status === "number" && record.status >= 400) return record.status;
    if (typeof record.statusCode === "number" && record.statusCode >= 400) return record.statusCode;
  }
  if (reply.statusCode >= 400) return reply.statusCode;
  return 500;
}

/** Adds nothing when the DSN is unset, so Fastify's reply stays the one
    the routes already had. */
export async function armServerErrorCapture(app: FastifyInstance): Promise<void> {
  await startErrorTracking();
  if (!errorTrackingEnabled()) return;
  const sentry = await import("@sentry/node");
  app.addHook("onError", async (request, reply, error) => {
    if (statusOf(error, reply) < 500) return;
    try {
      const secrets = secretsFromRequest({
        headers: request.headers as Record<string, unknown>,
        body: request.body,
        query: request.query as unknown,
      });
      const route = request.routeOptions?.url || request.url.split("?")[0] || "";
      sentry.withScope((scope) => {
        scope.setTag("method", request.method);
        scope.setTag("route", route);
        scope.addEventProcessor((event) => scrubEvent(event, secrets));
        sentry.captureException(error);
      });
    } catch (reportError) {
      request.log.error({ name: reportError instanceof Error ? reportError.name : "Error" }, "error report failed");
    }
  });
}

/** A desk report is four fields. Anything else was rejected before this runs. */
export async function captureClientReport(report: { message: string; stack?: string; route?: string; version?: string }): Promise<void> {
  if (!errorTrackingEnabled()) return;
  const sentry = await import("@sentry/node");
  sentry.withScope((scope) => {
    scope.setTag("source", "browser");
    if (report.route) scope.setTag("route", report.route);
    if (report.version) scope.setTag("app_version", report.version);
    scope.addEventProcessor((event) => scrubEvent(event, []));
    sentry.captureMessage(report.message, { level: "error", extra: report.stack ? { stack: report.stack } : undefined });
  });
}
