import type { Pool } from "pg";

export type PoolErrorPayload = { name: string; message: string; code: string | undefined };
export type PoolErrorLog = { error: (payload: PoolErrorPayload, message: string) => void };

const fallback: PoolErrorLog = {
  error(payload, message) { console.error(message, payload); },
};
let poolErrorLog: PoolErrorLog = fallback;

export function setPoolErrorLog(log: PoolErrorLog): void {
  poolErrorLog = log;
}

function redact(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]")
    .replace(/password=\S+/gi, "password=[redacted]");
}

function payloadOf(err: unknown): PoolErrorPayload {
  const name = err instanceof Error ? err.name : "Error";
  const raw = err instanceof Error ? err.message : "unknown error";
  const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
  return { name, message: redact(raw), code };
}

/* Logs a new object. Does not pass err or the client through, and does not exit. */
export function attachPoolErrorHandler(pool: Pool): void {
  pool.on("error", (err: Error) => {
    const { name, message, code } = payloadOf(err);
    poolErrorLog.error({ name, message, code }, "idle postgres client closed");
  });
}
