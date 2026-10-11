/* Public monitoring routes. Neither asks for a session: a desk reports
   an error when the session itself is what broke, and the deep check is
   for an operator. Both are rate-limited in process memory. Render runs
   one instance; a restart forgetting the count is a few extra reports,
   not a second book. The key is the TCP peer (request.ip). A forwarded
   header can be spoofed, and trusting it would make the limit optional. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { createRequire } from "node:module";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { captureClientReport, errorTrackingEnabled } from "./sentry.js";

const { version: SERVER_VERSION } = createRequire(import.meta.url)("../../package.json") as { version: string };

export const CLIENT_ERROR_LIMIT = 30;
export const DEEP_HEALTH_LIMIT = 30;
const WINDOW_MS = 60_000;
const CLIENT_ERROR_BODY_LIMIT = 4096;

const clientErrorBody = z.object({
  message: z.string().trim().min(1).max(500),
  stack: z.string().max(2000).optional(),
  version: z.string().max(40).optional(),
  route: z.string().max(200).optional(),
}).strict();

type Bucket = { resetAt: number; count: number };
const buckets = new Map<string, Bucket>();

export function resetRateLimits(): void {
  buckets.clear();
}

function take(key: string, limit: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  if (buckets.size > 500) {
    for (const [id, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(id);
  }
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { resetAt: now + WINDOW_MS, count: 1 });
    return { ok: true };
  }
  if (bucket.count >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  bucket.count += 1;
  return { ok: true };
}

function peer(request: FastifyRequest): string {
  return request.ip || "unknown";
}

function commitSha(): string | null {
  const raw = process.env.RENDER_GIT_COMMIT?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/i.test(raw) ? raw : null;
}

async function migrationCount(db: Db): Promise<number | null> {
  try {
    const result: unknown = await db.execute(sql`select count(*)::int as n from schema_migrations`);
    const rows = Array.isArray(result)
      ? result
      : result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)
        ? result.rows
        : [];
    const first = rows[0];
    if (!first || typeof first !== "object" || !("n" in first)) return null;
    const parsed = Number((first as { n: unknown }).n);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // The embedded database does not run the checksummed migrations, so
    // the table is absent there. Absent is null, not zero: zero would
    // mean the table exists and nothing has been applied.
    if (!/schema_migrations|does not exist/i.test(message)) {
      console.error(JSON.stringify({ event: "deep-health", error: "migrations", name: error instanceof Error ? error.name : "Error" }));
    }
    return null;
  }
}

export function registerMonitoringRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/client-errors", { bodyLimit: CLIENT_ERROR_BODY_LIMIT }, async (request, reply) => {
    const limit = take(`client-error:${peer(request)}`, CLIENT_ERROR_LIMIT);
    if (!limit.ok) return reply.code(429).header("retry-after", String(limit.retryAfter)).send({ error: "rate_limited" });
    const parsed = clientErrorBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_report" });
    const report = parsed.data;
    if (errorTrackingEnabled()) {
      await captureClientReport(report);
    } else {
      // One line. Only the four fields the desk is allowed to send.
      console.info(JSON.stringify({
        event: "client-error",
        message: report.message,
        route: report.route ?? null,
        version: report.version ?? null,
        stack: report.stack ?? null,
      }));
    }
    return reply.code(204).send();
  });

  app.get("/api/health/deep", async (request, reply) => {
    const limit = take(`deep-health:${peer(request)}`, DEEP_HEALTH_LIMIT);
    if (!limit.ok) return reply.code(429).header("retry-after", String(limit.retryAfter)).send({ ok: false, error: "rate_limited" });
    try {
      await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
    } catch (error) {
      request.log.error({ name: error instanceof Error ? error.name : "Error" }, "deep health database read failed");
      return reply.code(503).send({ ok: false, service: "currencydesk-server", error: "database" });
    }
    return {
      ok: true,
      service: "currencydesk-server",
      migrations: await migrationCount(db),
      version: SERVER_VERSION,
      commit: commitSha(),
    };
  });
}
