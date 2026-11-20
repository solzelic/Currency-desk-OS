/* CD-273 step-up, owner authenticator, recovery codes, and session revoke. */
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { ownerSecondStepReady, removalBlocked } from "../src/auth/methods.js";
import { verifyOwnerFactor } from "../src/auth/owner-mfa.js";

let handle: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SIGNIN_GOOGLE = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  delete process.env.SIGNIN_GOOGLE;
  await app.close();
  await handle.close();
});

function sessionCookie(res: { headers: { "set-cookie"?: string | string[] } }): string {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join(";") : String(raw ?? "");
  const token = /cdos_session=([^;]+)/.exec(joined)?.[1];
  return `cdos_session=${token}`;
}

async function login(staffId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(res.statusCode).toBe(200);
  return sessionCookie(res);
}

describe("step-up and owner recovery", () => {
  it("refuses to drop the last connected method", () => {
    const only = [
      { id: "password" as const, name: "Email and password", connected: true },
      { id: "google" as const, name: "Google", connected: false },
    ];
    expect(removalBlocked(only, "password")).toBe(true);
    expect(removalBlocked([
      ...only,
      { id: "google" as const, name: "Google", connected: true },
    ], "google")).toBe(false);
  });

  it("enrolls an authenticator only after step-up and stores recovery codes as hashes", async () => {
    const ownerId = `${DEMO.tenantId}:j.masri`;
    await handle.db.delete(schema.staffTotp).where(eq(schema.staffTotp.staffUserId, ownerId));
    await handle.db.delete(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, ownerId));
    const cookie = await login("j.masri");
    const early = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll/start", headers: { cookie } });
    expect(early.statusCode).toBe(403);
    expect(early.json()).toMatchObject({ error: "step_up_required" });

    const stepped = await app.inject({
      method: "POST",
      url: "/api/auth/stepup",
      headers: { cookie },
      payload: { password: DEMO.password },
    });
    expect(stepped.statusCode).toBe(200);

    const started = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll/start", headers: { cookie } });
    expect(started.statusCode).toBe(200);
    const body = started.json() as { ticket: string; manualSecret: string; backupCodes: string[] };
    expect(body.backupCodes).toHaveLength(10);
    const code = new TOTP({
      issuer: "CurrencyDesk",
      label: "j.masri",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(body.manualSecret),
    }).generate();
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/enroll/confirm",
      headers: { cookie },
      payload: { ticket: body.ticket, code },
    });
    expect(confirmed.statusCode).toBe(200);
    const stored = await handle.db.select().from(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, `${DEMO.tenantId}:j.masri`));
    expect(stored).toHaveLength(10);
    expect(stored.every((row) => row.codeHash.startsWith("scrypt$"))).toBe(true);
    expect(stored.some((row) => row.codeHash.includes(body.backupCodes[0]!))).toBe(false);
    const user = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:j.masri`)).limit(1))[0]!;
    expect(await ownerSecondStepReady(handle.db, user)).toBe(true);

    const factor = await verifyOwnerFactor(handle.db, user, body.backupCodes[0]!, "203.0.113.20");
    expect(factor).toEqual({ ok: true, factor: "backup" });
    expect(await verifyOwnerFactor(handle.db, user, body.backupCodes[0]!, "203.0.113.20")).toMatchObject({ ok: false });
    expect(await ownerSecondStepReady(handle.db, user)).toBe(true);
  });

  it("revokes sessions when a role changes", async () => {
    const teller = await login("m.costa");
    const owner = await login("j.masri");
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/staff/m.costa",
      headers: { cookie: owner },
      payload: { role: "supervisor" },
    });
    expect(patched.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: teller } });
    expect(me.statusCode).toBe(401);
    await handle.db.update(schema.staffUsers).set({ role: "teller" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
  });

  it("refuses a password-only step-up once an authenticator exists", async () => {
    const cookie = await login("j.masri");
    const alone = await app.inject({
      method: "POST",
      url: "/api/auth/stepup",
      headers: { cookie },
      payload: { password: DEMO.password },
    });
    expect(alone.statusCode).toBe(403);
    expect(alone.json()).toMatchObject({ error: "factor_required" });
    await handle.db.insert(schema.staffPasskeys).values({
      id: "pk-costa", tenantId: DEMO.tenantId, staffUserId: `${DEMO.tenantId}:m.costa`,
      credentialId: "cred-costa", publicKey: "aa", signCount: 0,
    });
    const teller = await login("m.costa");
    const passkeyAlone = await app.inject({
      method: "POST",
      url: "/api/auth/stepup",
      headers: { cookie: teller },
      payload: { password: DEMO.password },
    });
    expect(passkeyAlone.statusCode).toBe(403);
    await handle.db.delete(schema.staffPasskeys).where(eq(schema.staffPasskeys.id, "pk-costa"));
  });

  it("locks the fifth wrong authenticator code and records the failure", async () => {
    const cookie = await login("j.masri");
    await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: DEMO.password, totp: "000000" } });
    let last = 0;
    for (let n = 0; n < 4; n += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/stepup",
        headers: { cookie },
        payload: { password: DEMO.password, totp: "000000" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    const audits = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorId, `${DEMO.tenantId}:j.masri`));
    expect(audits.some((event) => event.action === "auth.login_failed" || event.action === "auth.login_locked")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("000000");
  });

  it("invalidates a leftover enroll ticket", async () => {
    await handle.db.delete(schema.staffTotp).where(eq(schema.staffTotp.staffUserId, `${DEMO.tenantId}:r.haddad`));
    await handle.db.delete(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, `${DEMO.tenantId}:r.haddad`));
    await handle.db.update(schema.staffUsers).set({ role: "administrator" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:r.haddad`));
    const cookie = await login("r.haddad");
    expect((await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: DEMO.password } })).statusCode).toBe(200);
    const first = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll/start", headers: { cookie } });
    const second = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll/start", headers: { cookie } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = first.json() as { ticket: string; manualSecret: string; backupCodes: string[] };
    const b = second.json() as { ticket: string; manualSecret: string };
    const code = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(a.manualSecret) }).generate();
    expect((await app.inject({
      method: "POST", url: "/api/auth/mfa/enroll/confirm", headers: { cookie },
      payload: { ticket: a.ticket, code },
    })).statusCode).toBe(200);
    const other = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(b.manualSecret) }).generate();
    const again = await app.inject({
      method: "POST", url: "/api/auth/mfa/enroll/confirm", headers: { cookie },
      payload: { ticket: b.ticket, code: other },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "already_enrolled" });
    const stored = await handle.db.select().from(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, `${DEMO.tenantId}:r.haddad`));
    expect(stored).toHaveLength(10);
    expect(stored.some((row) => row.codeHash.includes(a.backupCodes[0]!))).toBe(false);
    await handle.db.update(schema.staffUsers).set({ role: "branch_manager" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:r.haddad`));
  });

  it("locks repeated passkey option requests", async () => {
    process.env.WEBAUTHN_RP_ID = "currencydeskos.test";
    process.env.WEBAUTHN_ORIGINS = "https://currencydeskos.test";
    const cookie = await login("a.singh");
    let status = 0;
    for (let n = 0; n < 5; n += 1) {
      const res = await app.inject({ method: "POST", url: "/api/auth/stepup/passkey/options", headers: { cookie } });
      status = res.statusCode;
    }
    expect(status).toBe(429);
    let verifyStatus = 0;
    for (let n = 0; n < 5; n += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/stepup/passkey/verify",
        headers: { cookie },
        payload: { id: "nope", rawId: "nope", type: "public-key", response: {} },
      });
      verifyStatus = res.statusCode;
    }
    expect(verifyStatus).toBe(429);
  });

  it("answers one 503 when every sign-in flag is off and does not write twice", async () => {
    const saved = process.env.SIGNIN_GOOGLE;
    delete process.env.SIGNIN_GOOGLE;
    delete process.env.SIGNIN_MICROSOFT;
    delete process.env.SIGNIN_PASSKEY;
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    const quiet = await buildApp(handle.db, {}, stream);
    const crashes: string[] = [];
    const onReject = (err: unknown) => {
      crashes.push(err instanceof Error ? err.message : String(err));
    };
    const routes = [
      "/api/auth/stepup/email",
      "/api/auth/stepup",
      "/api/auth/stepup/passkey/options",
      "/api/auth/stepup/passkey/verify",
      "/api/auth/mfa/enroll/start",
      "/api/auth/mfa/enroll/confirm",
      "/api/auth/mfa/recovery",
    ];
    process.on("unhandledRejection", onReject);
    const answers = [];
    for (const url of routes) {
      const res = await quiet.inject({ method: "POST", url, payload: {} });
      await new Promise((resolve) => setImmediate(resolve));
      answers.push({ url, status: res.statusCode, body: res.json() });
    }
    process.off("unhandledRejection", onReject);
    await quiet.close();
    process.env.SIGNIN_GOOGLE = saved;
    expect(answers).toEqual(routes.map((url) => ({ url, status: 503, body: { error: "not_available" } })));
    const noise = `${logs.join("\n")}\n${crashes.join("\n")}`;
    expect(noise).not.toContain("Cannot write headers after they are sent");
  });
});
