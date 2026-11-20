/** Real PostgreSQL barriers: requests must be observed waiting on locks before
 * release. No scheduling sleeps, fake proof store, or mocked session/audit. */
import { setImmediate } from "node:timers/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { createLoginProof, consumeLoginProof, noteWrongCode, LOGIN_PROOF_COOKIE, CODE_REFUSAL } from "../src/auth/signin-guard.js";
import { forget } from "../src/cooldown.js";
import * as mailer from "../src/email.js";

const url = process.env.TEST_DATABASE_URL;
const EMAIL = "proof-owner@example.test";
const USER = `${DEMO.tenantId}:${EMAIL}`;
const CODE = "765432";
const PASS = "four proof testing words";
const cookie = (r: { cookies: { name: string; value: string }[] }, name: string) => r.cookies.find(c => c.name === name)?.value;

describe.skipIf(!url)("emailed login proof consumption on PostgreSQL", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let proof: Awaited<ReturnType<typeof createLoginProof>>;
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", url!);
    vi.stubEnv("SEED_PASSWORD", "yorkville");
    handle = await createDb();
    await seed(handle.db);
    pool = new pg.Pool({ connectionString: url });
    await handle.db.insert(schema.staffUsers).values({ id: USER, staffId: EMAIL, name: "Proof Owner", role: "administrator", tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId, passwordHash: await hashPassword(PASS) });
    app = await buildApp(handle.db);
  });
  afterAll(async () => { await app?.close(); await handle?.close(); await pool?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [USER]);
    await pool.query("DELETE FROM signin_failures");
    await pool.query("UPDATE staff_users SET active = true WHERE id = $1", [USER]);
    await pool.query("UPDATE tenants SET suspended = false WHERE id = $1", [DEMO.tenantId]);
    proof = await createLoginProof(handle.db, USER, mailer.hashCode(CODE));
  });
  const verify = (code = CODE, staffId = EMAIL, token: string | undefined = proof.token) => app.inject({ method: "POST", url: "/api/auth/login/verify", cookies: token ? { [LOGIN_PROOF_COOKIE]: token } : {}, payload: { staffId, code, tenantId: "untrusted-other-tenant" } }).then(r => r);
  const sessions = async () => Number((await pool.query("SELECT count(*) FROM sessions WHERE user_id = $1", [USER])).rows[0].count);
  const audits = async () => Number((await pool.query("SELECT count(*) FROM audit_events WHERE actor_id = $1 AND action = 'auth.login'", [USER])).rows[0].count);
  async function waiting(count: number, fragment = "login_challenges") {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1", [`%${fragment}%`]);
      if (Number(r.rows[0].count) >= count) return;
      await setImmediate();
    }
    throw new Error(`Did not observe ${count} blocked ${fragment} requests`);
  }
  async function barrier(kind: "table" | "row") {
    const client = await pool.connect();
    await client.query("BEGIN");
    if (kind === "table") await client.query("LOCK TABLE login_challenges IN SHARE MODE");
    else await client.query("SELECT token_hash FROM login_challenges WHERE token_hash = $1 FOR UPDATE", [proof.tokenHash]);
    return { client, release: async () => { await client.query("COMMIT"); client.release(); } };
  }

  it.each(["login_challenges", "staff_users", "tenants"] as const)("bounds %s contention and preserves the proof for retry", async table => {
    const before = await audits();
    const client = await pool.connect();
    await client.query("BEGIN");
    // The table name is only one of this test's three fixed constants.
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    const pending = verify();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await waiting(1, table);
      const response = await Promise.race([
        pending,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 6500); }),
      ]);
      expect(response, "verify must finish while the external lock is still held").not.toBeNull();
      if (!response) return;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "temporarily_unavailable" });
      expect(response.cookies).toHaveLength(0);
    } finally {
      clearTimeout(timer);
      await client.query("ROLLBACK"); client.release();
      await pending;
    }
    expect(await sessions()).toBe(0);
    expect(await audits()).toBe(before);
    expect((await pool.query("SELECT attempts FROM login_challenges WHERE token_hash = $1", [proof.tokenHash])).rows).toEqual([{ attempts: 0 }]);
    expect((await verify()).statusCode).toBe(200);
  }, 15_000);

  it("restores the lock budget after successful commit on the same connection", async () => {
    const client = await pool.connect();
    const dedicatedApp = await buildApp(drizzle(client, { schema }));
    try {
      const before = await client.query("SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS budget");
      expect(before.rows[0].budget).toBe("0");
      const response = await dedicatedApp.inject({ method: "POST", url: "/api/auth/login/verify", cookies: { [LOGIN_PROOF_COOKIE]: proof.token }, payload: { staffId: EMAIL, code: CODE } });
      expect(response.statusCode).toBe(200);
      const after = await client.query("SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS budget");
      expect(after.rows).toEqual(before.rows);
    } finally {
      await dedicatedApp.close();
      await client.query("RESET lock_timeout");
      client.release();
    }
  });

  it("conditional proof writes reject an exhausted row even without the route's locked read", async () => {
    await pool.query("UPDATE login_challenges SET attempts = 5 WHERE token_hash = $1", [proof.tokenHash]);
    await handle.db.transaction(async tx => {
      expect(await noteWrongCode(tx, proof.tokenHash)).toBe(false);
      expect(await consumeLoginProof(tx, proof.tokenHash)).toBe(false);
    });
    expect((await pool.query("SELECT attempts FROM login_challenges WHERE token_hash = $1", [proof.tokenHash])).rows).toEqual([{ attempts: 5 }]);
    expect(await sessions()).toBe(0);
  });

  it("spends one proof once in a concurrent success burst, then refuses replay", async () => {
    const before = await audits();
    const gate = await barrier("table");
    const pending = Array.from({ length: 6 }, () => verify());
    try { await waiting(6); } finally { await gate.release(); }
    const results = await Promise.all(pending);
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter(r => cookie(r, "cdos_session"))).toHaveLength(1);
    expect(await sessions()).toBe(1);
    expect(await audits()).toBe(before + 1);
    expect((await verify()).statusCode).toBe(401);
  });

  it("accounts for exactly five wrong guesses in a burst", async () => {
    const gate = await barrier("table");
    const pending = Array.from({ length: 5 }, () => verify("000000"));
    try { await waiting(5); } finally { await gate.release(); }
    expect((await Promise.all(pending)).map(r => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    const row = await pool.query("SELECT attempts FROM login_challenges WHERE token_hash = $1", [proof.tokenHash]);
    expect(row.rows[0].attempts).toBe(5);
    expect((await verify()).statusCode).toBe(429);
    expect(await sessions()).toBe(0);
  });

  it("a correct code queued behind the fifth wrong guess cannot win through a stale read", async () => {
    await pool.query("UPDATE login_challenges SET attempts = 4 WHERE token_hash = $1", [proof.tokenHash]);
    const gate = await barrier("row");
    const wrong = verify("000000");
    let right: ReturnType<typeof verify> | undefined;
    try { await waiting(1); right = verify(); await waiting(2); } finally { await gate.release(); }
    expect((await wrong).statusCode).toBe(401);
    expect((await right!).statusCode).toBe(429);
    expect(await sessions()).toBe(0);
  });

  it("one correct request ahead of wrong requests consumes the proof without resurrection", async () => {
    const before = await audits();
    const gate = await barrier("row");
    const right = verify();
    const wrong: ReturnType<typeof verify>[] = [];
    try { await waiting(1); wrong.push(verify("000000"), verify("000000")); await waiting(3); }
    finally { await gate.release(); }
    expect((await right).statusCode).toBe(200);
    expect((await Promise.all(wrong)).every(r => r.statusCode !== 200 && !cookie(r, "cdos_session"))).toBe(true);
    expect(await sessions()).toBe(1);
    expect(await audits()).toBe(before + 1);
    expect((await pool.query("SELECT token_hash FROM login_challenges WHERE token_hash = $1", [proof.tokenHash])).rows).toHaveLength(0);
  });

  it.each(["staff_users", "tenants"] as const)("rechecks authority after waiting for %s", async table => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [table === "staff_users" ? USER : DEMO.tenantId]);
    const pending = verify();
    try {
      await waiting(1, table);
      await client.query(table === "staff_users" ? "UPDATE staff_users SET active = false WHERE id = $1" : "UPDATE tenants SET suspended = true WHERE id = $1", [table === "staff_users" ? USER : DEMO.tenantId]);
    } finally { await client.query("COMMIT"); client.release(); }
    expect((await pending).statusCode).toBe(table === "staff_users" ? 401 : 403);
    expect(await sessions()).toBe(0);
  });

  it.each(["expired", "exhausted"] as const)("rechecks %s after a blocking transaction", async state => {
    const gate = await barrier("row");
    const pending = verify();
    try {
      await waiting(1);
      await gate.client.query(state === "expired" ? "UPDATE login_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1" : "UPDATE login_challenges SET attempts = 5 WHERE token_hash = $1", [proof.tokenHash]);
    } finally { await gate.release(); }
    const response = await pending;
    expect(response.statusCode).toBe(state === "expired" ? 410 : 429);
    expect(cookie(response, "cdos_session")).toBeUndefined();
    expect(await sessions()).toBe(0);
  });

  it.each([CODE, "000000"])("checks wall-clock expiry again after loading the proof and waiting on identity (%s)", async entered => {
    const client = await pool.connect();
    await client.query("UPDATE login_challenges SET expires_at = clock_timestamp() + interval '2 seconds' WHERE token_hash = $1", [proof.tokenHash]);
    await client.query("BEGIN");
    await client.query("LOCK TABLE staff_users IN ACCESS EXCLUSIVE MODE");
    const pending = verify(entered);
    try {
      await waiting(1, "staff_users");
      const deadline = Date.now() + 5000;
      for (;;) {
        const r = await pool.query("SELECT expires_at <= clock_timestamp() AS expired FROM login_challenges WHERE token_hash = $1", [proof.tokenHash]);
        if (r.rows[0].expired) break;
        if (Date.now() > deadline) throw new Error("Database expiry boundary not reached");
        await setImmediate();
      }
    } finally { await client.query("COMMIT"); client.release(); }
    expect((await pending).statusCode).toBe(410);
    expect(await sessions()).toBe(0);
  });

  it.each(["login_challenges", "sessions", "audit_events"] as const)("rolls back proof/session/audit together when %s write fails", async table => {
    const before = await audits();
    await pool.query("CREATE FUNCTION proof_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private dependency detail'; END $$");
    await pool.query(`CREATE TRIGGER proof_test_failure BEFORE ${table === "login_challenges" ? "DELETE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION proof_test_refuse()`);
    try {
      const response = await verify();
      expect.soft(response.statusCode).toBe(503);
      expect.soft(response.body).not.toContain("private dependency detail");
      expect.soft(response.cookies).toHaveLength(0);
      expect.soft(await sessions()).toBe(0);
      expect.soft(await audits()).toBe(before);
      expect.soft((await pool.query("SELECT token_hash FROM login_challenges WHERE token_hash = $1", [proof.tokenHash])).rows).toHaveLength(1);
    } finally { await pool.query(`DROP TRIGGER proof_test_failure ON ${table}`); await pool.query("DROP FUNCTION proof_test_refuse()"); }
    expect.soft((await verify()).statusCode).toBe(200);
    expect.soft(await sessions()).toBe(1);
  });

  it("keeps absent, unknown and mismatched proofs anonymous and rejects inactive/suspended owners", async () => {
    const absent = await verify(CODE, EMAIL, "");
    const unknown = await verify(CODE, "stranger@example.test", "unissued");
    expect(absent.statusCode).toBe(401); expect(absent.json()).toEqual(CODE_REFUSAL);
    expect(unknown.statusCode).toBe(401); expect(unknown.json()).toEqual(CODE_REFUSAL);
    expect((await verify(CODE, "stranger@example.test")).statusCode).toBe(401);
    await pool.query("UPDATE staff_users SET active = false WHERE id = $1", [USER]);
    expect((await verify()).statusCode).toBe(401);
    await pool.query("UPDATE staff_users SET active = true WHERE id = $1", [USER]);
    await pool.query("UPDATE tenants SET suspended = true WHERE id = $1", [DEMO.tenantId]);
    expect((await verify()).statusCode).toBe(403);
    expect(await sessions()).toBe(0);
  });

  it("fails closed on a proof-store read error without consuming the proof or setting cookies", async () => {
    await pool.query("ALTER TABLE login_challenges RENAME TO proof_test_unavailable");
    try {
      const absent = await verify(CODE, EMAIL, "");
      expect(absent.statusCode).toBe(401); // no proof means no database lookup
      const response = await verify();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "temporarily_unavailable" });
      expect(response.cookies).toHaveLength(0);
      expect(await sessions()).toBe(0);
    } finally { await pool.query("ALTER TABLE proof_test_unavailable RENAME TO login_challenges"); }
    expect((await verify()).statusCode).toBe(200);
  });

  it("real HTTP password → generated emailed code → session resolves the authoritative tenant", async () => {
    forget();
    let delivered = "";
    const mail = vi.spyOn(mailer, "sendEmail").mockImplementation(async (_to, subject) => { delivered = subject; return "sent"; });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const post = (path: string, payload: object, cookies = "") => fetch(`${address}/api/auth/login${path}`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookies }, body: JSON.stringify(payload),
    });
    const responseCookie = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(";", 1)[0];
    try {
      const start = await post("/password", { identifier: EMAIL, password: PASS });
      expect(start.status).toBe(200);
      expect(await start.json()).toMatchObject({ next: "code", needsCode: true });
      expect(responseCookie(start, "cdos_session")).toBeUndefined();
      const generated = delivered.match(/\b\d{6}\b/)?.[0];
      const proofCookie = responseCookie(start, LOGIN_PROOF_COOKIE);
      if (!generated || !proofCookie) throw new Error("No generated email/proof");
      const signed = await post("/verify", { staffId: EMAIL, code: generated, tenantId: "untrusted-other-tenant" }, proofCookie);
      expect(signed.status).toBe(200);
      expect(await signed.json()).toMatchObject({ user: { tenantId: DEMO.tenantId } });
      const session = responseCookie(signed, "cdos_session");
      if (!session) throw new Error("No session");
      const me = await fetch(`${address}/api/auth/me`, { headers: { cookie: session } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ user: { id: EMAIL, tenantId: DEMO.tenantId } });
      const tenant = await fetch(`${address}/api/tenant`, { headers: { cookie: session } });
      expect(tenant.status).toBe(200);
      expect(await tenant.json()).toMatchObject({ tenant: { id: DEMO.tenantId } });
      const replay = await post("/verify", { staffId: EMAIL, code: generated }, proofCookie);
      expect(replay.status).toBe(401);
      await replay.arrayBuffer();
    } finally { mail.mockRestore(); }
    // afterAll closes the owned ephemeral listener and database handles.
  });
});
