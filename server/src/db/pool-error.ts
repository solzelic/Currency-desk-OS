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

/* Slice first, then URLs, then key=value, then user:pass@host. */
export function redactPoolMessage(message: string): string {
  return message.slice(0, 500)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted]")
    .replace(/\b(ssl)?(password|passfile|key|cert|rootcert)\s*=\s*('(?:[^'\\]|\\.)*'|"[^"]*"|\S+)/gi, "[redacted]")
    .replace(/\S+:\S+@\S+/g, "[redacted]");
}

function payloadOf(err: unknown): PoolErrorPayload {
  const name = err instanceof Error ? err.name : "Error";
  const raw = err instanceof Error ? err.message : "unknown error";
  const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
  return { name, message: redactPoolMessage(raw), code };
}

function logPoolError(err: unknown): void {
  const { name, message, code } = payloadOf(err);
  poolErrorLog.error({ name, message, code }, "idle postgres client closed");
}

/* Pool errors are idle clients. A checked-out client emits on the client. */
export function attachPoolErrorHandler(pool: Pool): void {
  pool.on("error", (err: Error) => { logPoolError(err); });
  pool.on("connect", (client) => {
    client.on("error", (err: Error) => { logPoolError(err); });
  });
}
