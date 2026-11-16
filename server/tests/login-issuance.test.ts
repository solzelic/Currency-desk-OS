/** Shared PostgreSQL/PGlite lifecycle; native races use observed database locks.
 * All identities and mail are synthetic. Never include proofs/codes in failures. */
import { setImmediate } from "node:timers/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { createLoginProof, LOGIN_PROOF_COOKIE } from "../src/auth/signin-guard.js";
import { forget } from "../src/cooldown.js";
import * as mailer from "../src/email.js";

// Drizzle errors can include query parameters. Preserve failure without secrets.
const issueProof = (...args: Parameters<typeof createLoginProof>) => createLoginProof(...args)
  .catch(() => { throw new Error("Synthetic proof issuance failed"); });
const url = process.env.TEST_DATABASE_URL;
const EMAIL = "issuance@example.test", USER = `${DEMO.tenantId}:${EMAIL}`;
const OTHER = `${DEMO.tenantId}:issuance-other@example.test`;
const PASS = "four synthetic issuance words", CODE = "846291";
const cookie = (r: { cookies: { name: string; value: string }[] }, name: string) => r.cookies.find(c => c.name === name)?.value;

describe("atomic login proof issuance", () => {
  let handle: DbHandle, app: FastifyInstance, pool: pg.Pool;
  let old: Awaited<ReturnType<typeof createLoginProof>>;
  beforeAll(async () => {
    if (url) vi.stubEnv("DATABASE_URL", url);
    else { vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("PGLITE_MEMORY", "1"); }
    vi.stubEnv("SEED_PASSWORD", "yorkville");
    handle = await createDb(); await seed(handle.db);
    const passwordHash = await hashPassword(PASS);
    await handle.db.insert(schema.staffUsers).values([USER, OTHER].map(id => ({ id,
      staffId: id.slice(DEMO.tenantId.length + 1), name: "Synthetic Issuance", role: "administrator" as const,
      tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId, passwordHash })));
    app = await buildApp(handle.db);
    if (url) pool = new pg.Pool({ connectionString: url });
    vi.spyOn(mailer, "sendEmail").mockResolvedValue("sent");
  });
  afterAll(async () => { await app?.close(); await handle?.close(); await pool?.end(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    forget(); vi.mocked(mailer.sendEmail).mockClear();
    await handle.db.execute(sql`DELETE FROM signin_failures`);
    await handle.db.execute(sql`DELETE FROM sessions WHERE user_id IN (${USER}, ${OTHER})`);
    old = await issueProof(handle.db, USER, mailer.hashCode(CODE));
  });
  const issue = () => issueProof(handle.db, USER, mailer.hashCode(CODE));
  const password = () => app.inject({ method: "POST", url: "/api/auth/login/password", payload: { identifier: EMAIL, password: PASS } }).then(r => r);
  const verify = (token = old.token, code = CODE) => app.inject({ method: "POST", url: "/api/auth/login/verify",
    cookies: { [LOGIN_PROOF_COOKIE]: token }, payload: { staffId: EMAIL, code, tenantId: "untrusted-tenant" } }).then(r => r);
  const count = async () => Number((await handle.db.execute(sql`SELECT count(*) AS n FROM login_challenges WHERE user_id = ${USER}`)).rows[0]!.n);

  it.each(["repeatable read", "serializable"] as const)("refuses incompatible outer isolation (%s) without replacing the old proof", async isolationLevel => {
    await expect(handle.db.transaction(async tx => {
      await issueProof(tx, USER, mailer.hashCode(CODE));
    }, { isolationLevel })).rejects.toThrow("Synthetic proof issuance failed");
    expect(await count()).toBe(1);
    expect((await verify()).statusCode).toBe(200);
  });

  it("committed replacement invalidates the old proof and grants only the new proof's session", async () => {
    const next = await issue();
    expect(await count()).toBe(1);
    expect((await verify()).statusCode).toBe(401);
    const signed = await verify(next.token);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().user.tenantId).toBe(DEMO.tenantId);
    expect((await verify(next.token)).statusCode).toBe(401);
  });

  it.each([false, true])("confirmed rollback preserves the previous proof (deferred failure=%s)", async deferred => {
    await handle.db.execute(sql.raw(`CREATE FUNCTION issuance_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic issuance failure'; END $$`));
    await handle.db.execute(sql.raw(deferred
      ? "CREATE CONSTRAINT TRIGGER issuance_fail AFTER INSERT ON login_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION issuance_fail()"
      : "CREATE TRIGGER issuance_fail BEFORE INSERT ON login_challenges FOR EACH ROW EXECUTE FUNCTION issuance_fail()"));
    try {
      const response = await password();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "temporarily_unavailable" });
      expect(response.cookies.length).toBe(0);
      expect(vi.mocked(mailer.sendEmail).mock.calls.length).toBe(0);
    } finally {
      await handle.db.execute(sql.raw("DROP TRIGGER issuance_fail ON login_challenges"));
      await handle.db.execute(sql.raw("DROP FUNCTION issuance_fail()"));
    }
    expect(await count()).toBe(1);
    expect((await verify()).statusCode).toBe(200);
  });

  it("releases issuance locks before mail, and late failed mail cannot delete a newer proof", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const held = new Promise<void>(r => { release = r; });
    vi.mocked(mailer.sendEmail).mockImplementationOnce(async () => { entered(); await held; return "failed"; });
    const first = password();
    try {
      await started;
      const second = await password();
      expect(second.statusCode).toBe(200);
      const token = cookie(second, LOGIN_PROOF_COOKIE);
      const generated = vi.mocked(mailer.sendEmail).mock.calls.at(-1)?.[1].match(/\b\d{6}\b/)?.[0];
      if (!token || !generated) throw new Error("Missing synthetic delivery");
      release(); expect((await first).statusCode).toBe(503);
      expect(await count()).toBe(1);
      expect((await verify(token, generated)).statusCode).toBe(200);
    } finally { release(); await first; }
  });

  describe.skipIf(!url)("native PostgreSQL barriers", () => {
    async function waiting(n: number, fragment = "") {
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        const r = await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1", [`%${fragment}%`]);
        if (Number(r.rows[0].n) >= n) return;
        await setImmediate();
      }
      throw new Error(`Expected ${n} observed database lock waits`);
    }
    async function insertGate(fail = false) {
      const blocker = await pool.connect();
      await blocker.query("SELECT pg_advisory_lock(221, 913)");
      await pool.query(`CREATE FUNCTION issuance_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.user_id = '${USER}' THEN PERFORM pg_advisory_xact_lock(221,913);
        ${fail ? "RAISE EXCEPTION 'synthetic issuance failure';" : ""}
        END IF; RETURN NEW; END $$`);
      await pool.query("CREATE TRIGGER issuance_gate BEFORE INSERT ON login_challenges FOR EACH ROW EXECUTE FUNCTION issuance_gate()");
      return async () => { await blocker.query("SELECT pg_advisory_unlock(221,913)"); blocker.release(); };
    }
    const dropGate = async () => { await pool.query("DROP TRIGGER issuance_gate ON login_challenges"); await pool.query("DROP FUNCTION issuance_gate()"); };

    it.each([false, true])("competing independent connections leave one usable proof (initially empty=%s)", async empty => {
      if (empty) await pool.query("DELETE FROM login_challenges WHERE user_id=$1", [USER]);
      const a = await pool.connect(), b = await pool.connect();
      // Issuance must explicitly refresh its DELETE snapshot after waiting,
      // even if a deployment changes the connection's default isolation.
      await a.query("SET default_transaction_isolation = 'repeatable read'");
      await b.query("SET default_transaction_isolation = 'repeatable read'");
      const release = await insertGate();
      const pending: ReturnType<typeof issue>[] = [];
      try {
        pending.push(issueProof(drizzle(a, { schema }), USER, mailer.hashCode(CODE)));
        await waiting(1, "insert into");
        pending.push(issueProof(drizzle(b, { schema }), USER, mailer.hashCode(CODE)));
        await waiting(2); // parent: two INSERTs; fixed: INSERT + per-account mutex
      } finally {
        await release(); await Promise.allSettled(pending); await dropGate();
        await a.query("RESET default_transaction_isolation"); await b.query("RESET default_transaction_isolation");
        a.release(); b.release();
      }
      const results = await Promise.all(pending);
      expect.soft(await count()).toBe(1);
      const statuses = [];
      for (const result of results) statuses.push((await verify(result.token)).statusCode);
      expect(statuses.sort()).toEqual([200, 401]);
    });

    it("a different account issues while the first account's insertion is held", async () => {
      const release = await insertGate();
      const pending = issue();
      let other: ReturnType<typeof issue> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await waiting(1, "insert into");
        other = issueProof(handle.db, OTHER, mailer.hashCode(CODE));
        const progressed = await Promise.race([other.then(() => true), new Promise<false>(r => { timer = setTimeout(() => r(false), 2000); })]);
        expect(progressed).toBe(true);
        expect(await count()).toBe(1); // old committed proof remains visible
      } finally { clearTimeout(timer); await release(); await Promise.allSettled([pending, other]); await dropGate(); }
    });

    it("replacement commits before an old-proof verifier and refuses that verifier", async () => {
      const release = await insertGate();
      const issuing = issue();
      let checking: ReturnType<typeof verify> | undefined;
      try {
        await waiting(1, "insert into");
        checking = verify();
        await waiting(2);
      } finally { await release(); await Promise.allSettled([issuing, checking]); await dropGate(); }
      const next = await issuing;
      expect((await checking)!.statusCode).toBe(401);
      expect((await verify(next.token)).statusCode).toBe(200);
    });

    it("a verifier waiting through replacement rollback can still consume the old proof", async () => {
      const release = await insertGate(true);
      const issuing = issue().then(() => true, () => false);
      let checking: ReturnType<typeof verify> | undefined;
      try {
        await waiting(1, "insert into");
        checking = verify();
        await waiting(2);
      } finally { await release(); await Promise.allSettled([issuing, checking]); await dropGate(); }
      expect(await issuing).toBe(false);
      expect((await checking)!.statusCode).toBe(200);
      expect(await count()).toBe(0);
    });

    it("verification holding proof and staff locks can finish before replacement", async () => {
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [DEMO.tenantId]);
      const checking = verify();
      let issuing: ReturnType<typeof issue> | undefined;
      try {
        await waiting(1, 'from "tenants"'); // verifier already owns proof + staff SHARE
        issuing = issue();
        await waiting(2);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled([checking, issuing]); }
      expect((await checking).statusCode).toBe(200);
      expect(await count()).toBe(1);
      expect((await verify()).statusCode).toBe(401);
      expect((await verify((await issuing)!.token)).statusCode).toBe(200);
    });

    it.each(["proof", "issuer"])("bounds %s contention with safe503 and preserves the old proof for retry", async kind => {
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      if (kind === "proof") await blocker.query("SELECT token_hash FROM login_challenges WHERE user_id=$1 FOR UPDATE", [USER]);
      else await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`login-proof:${USER}`]);
      const pending = password();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await waiting(1, kind === "proof" ? "login_challenges" : "pg_advisory_xact_lock");
        const response = await Promise.race([pending, new Promise<null>(r => { timer = setTimeout(() => r(null), 6500); })]);
        expect(response === null, "must settle while blocker remains held").toBe(false);
        if (response) { expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: "temporarily_unavailable" }); expect(response.cookies.length).toBe(0); }
        expect(vi.mocked(mailer.sendEmail).mock.calls.length).toBe(0);
      } finally { clearTimeout(timer); await blocker.query("ROLLBACK"); blocker.release(); await pending; }
      expect(await count()).toBe(1);
      expect((await verify()).statusCode).toBe(200);
    }, 15000);

    it("releases advisory lock and local budget after commit on the same connection", async () => {
      const client = await pool.connect();
      try {
        const before = await client.query("SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS budget");
        expect(before.rows[0].budget).toBe("0");
        await issueProof(drizzle(client, { schema }), USER, mailer.hashCode(CODE));
        const after = await client.query("SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS budget");
        expect(after.rows).toEqual(before.rows);
        expect((await client.query("SELECT count(*) AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n).toBe("0");
      } finally { await client.query("RESET lock_timeout"); client.release(); }
    });
  });
});
