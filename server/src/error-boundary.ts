import type { FastifyInstance } from "fastify";

const NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "AggregateError", "DatabaseError", "PostgresError", "DrizzleQueryError"]);
const CODES = new Set([
  "23502", "23503", "23505", "23514", "40001", "40P01", "42P01", "42P07", "42703",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "53300", "53400", "55P03", "57014", "57P01", "57P02", "57P03",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
]);

// Do not call getters/toJSON or traverse a cause: those can expose arbitrary
// payloads (including a Drizzle query and its parameter values).
function ownValue(error: unknown, key: string): unknown {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

/** Diagnostic identifiers and log-site/request context remain useful. Free
 * text is deliberately redacted wholesale: even an error's message can hold
 * customer values, not just its detail, stack, query or cause. */
export function safeError(error: unknown): { name: string; code?: string; message: string } {
  const name = ownValue(error, "name");
  const code = ownValue(error, "code");
  return {
    name: typeof name === "string" && NAMES.has(name) ? name : "Error",
    ...(typeof code === "string" && CODES.has(code) ? { code } : {}),
    message: "Unexpected error details redacted.",
  };
}

export const unexpectedErrorHandler: Parameters<FastifyInstance["setErrorHandler"]>[0] = (error, request, reply) => {
  const status = ownValue(error, "status");
  const statusCode = ownValue(error, "statusCode");
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
  const code = valid(status) ? status : valid(statusCode) ? statusCode : valid(reply.statusCode) ? reply.statusCode : 500;
  // Hand framework/client errors to Fastify's parent handler unchanged. This
  // preserves validation, malformed JSON, body-size, content-type and headers.
  // Explicit route response objects never enter this handler.
  if (code < 500) throw error;
  request.log.error({ error: safeError(error) }, "unexpected request failure");
  return reply.code(code).send({ code: "INTERNAL_ERROR", message: "Unexpected server error." });
};
