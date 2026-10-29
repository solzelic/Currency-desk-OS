import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/index.js";
import { attachPoolErrorHandler, setPoolErrorLog } from "../src/db/pool-error.js";
import { clearDeepHealthCache } from "../src/routes/admin.js";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const HOST = "staging.currencydeskos.com";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function idleError(): Error & { client?: unknown; code?: string } {
  const err = new Error(
    "Connection terminated unexpectedly postgres://user:secretpassword@127.0.0.1:1/none password=secretpassword",
  ) as Error & { client?: unknown; code?: string };
  err.code = "ECONNRESET";
  err.client = { connectionParameters: { password: "from-the-client" } };
  return err;
}

describe("idle pool error", () => {
  it("exits when the pool has no listener", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", [
      'import pg from "pg";',
      'const pool = new pg.Pool({ connectionString: "postgres://127.0.0.1:1/none" });',
      'setImmediate(() => { pool.emit("error", new Error("Connection terminated unexpectedly")); });',
      'setTimeout(() => { process.stdout.write("STAYED_UP\\n"); process.exit(0); }, 150);',
    ].join(" ")], { cwd: serverRoot, env: { PATH: process.env.PATH ?? "" } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(1);
    expect(stderr).toContain("Unhandled 'error' event");
    expect(stderr).toContain("Connection terminated unexpectedly");
  });

  it("stays up and logs only the redacted name, message, and code", async () => {
    const seen: unknown[] = [];
    setPoolErrorLog({ error(payload) { seen.push(payload); } });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const pool = new pg.Pool({ connectionString: "postgres://user:secretpassword@127.0.0.1:1/none" });
    attachPoolErrorHandler(pool);
    await new Promise<void>((resolve) => {
      setImmediate(() => { const err = idleError(); pool.emit("error", err, err.client); });
      setTimeout(resolve, 50);
    });
    expect(exit).not.toHaveBeenCalled();
    expect(seen).toEqual([{
      name: "Error",
      message: "Connection terminated unexpectedly postgres://[redacted] password=[redacted]",
      code: "ECONNRESET",
    }]);
    const logged = JSON.stringify(seen);
    expect(logged).not.toContain("secretpassword");
    expect(logged).not.toContain("from-the-client");
    expect(logged).not.toContain("client");
    expect(Object.keys(seen[0] as object)).toEqual(["name", "message", "code"]);
    await pool.end();
  });
});

describe("health after an idle client error", () => {
  it("stays up: shallow 200, deep 503 while the read throws, then deep 200", async () => {
    vi.stubEnv("PGLITE_MEMORY", "1");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("LEDGER_DATABASE_URL", "");
    vi.stubEnv("STAGING", "1");
    vi.stubEnv("RENDER_EXTERNAL_HOSTNAME", HOST);
    vi.stubEnv("RENDER_GIT_COMMIT", "");
    const seen: unknown[] = [];
    setPoolErrorLog({ error(payload) { seen.push(payload); } });
    const handle = await createDb();
    const app = await buildApp(handle.db);
    const pool = new pg.Pool({ connectionString: "postgres://127.0.0.1:1/none" });
    attachPoolErrorHandler(pool);
    const deep = () => app.inject({ method: "GET", url: "/api/health/deep", headers: { host: HOST } });
    await new Promise<void>((resolve) => {
      setImmediate(() => { const err = idleError(); pool.emit("error", err, err.client); });
      setTimeout(resolve, 30);
    });
    try {
      clearDeepHealthCache();
      const shallow = await app.inject({ method: "GET", url: "/api/health" });
      expect(shallow.statusCode).toBe(200);
      expect(shallow.json()).toEqual({ ok: true, service: "currencydesk-server" });
      const select = vi.spyOn(handle.db, "select").mockImplementation(() => { throw new Error("connect ECONNREFUSED"); });
      const down = await deep();
      expect(down.statusCode).toBe(503);
      expect(down.json()).toEqual({
        ok: false, service: "currencydesk-server", error: "database", commit: "unknown", lastMigration: null,
      });
      select.mockRestore();
      clearDeepHealthCache();
      const up = await deep();
      expect(up.statusCode).toBe(200);
      expect(up.json().ok).toBe(true);
      const logged = JSON.stringify(seen);
      expect(logged).not.toContain("secretpassword");
      expect(logged).not.toContain("from-the-client");
    } finally {
      await pool.end();
      await app.close();
      await handle.close();
    }
  });
});
