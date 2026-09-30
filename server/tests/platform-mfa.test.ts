/* Platform-operator MFA. Password, then TOTP. The first sign-in enrolls
   (secret shown once). After that a code is required, a backup code works
   once, and the desk door at /login stays password-only. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as OTPAuth from "otpauth";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { decryptSecret, encryptSecret } from "../src/auth/totp-secret.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { ensurePlatformAdmin } from "../src/admin-bootstrap.js";
import { forget as forgetCooldown } from "../src/cooldown.js";
import { eq } from "drizzle-orm";

const OPERATOR = "operator@currencydeskos.com";
const PASSWORD = "correct-horse-battery";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = OPERATOR;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  await ensurePlatformAdmin(handle.db, OPERATOR, PASSWORD);
  app = await buildApp(handle.db);
});
afterAll(async () => {
  await app.close();
  await handle.close();
  vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  delete process.env.EARLY_ACCESS_OPEN;
});
beforeEach(() => { logged = []; forgetCooldown(); });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((item) => item.name === "cdos_session");
  return c ? `cdos_session=${c.value}` : "";
};

function rejectingCode(totp: OTPAuth.TOTP): string {
  const good = totp.generate();
  for (let i = 1; i <= 40; i++) {
    const candidate = String((Number(good) + i) % 1_000_000).padStart(6, "0");
    if (totp.validate({ token: candidate, window: 1 }) === null) return candidate;
  }
  throw new Error("could not find a rejecting code");
}

function codeFromLog(): string {
  const line = [...logged].reverse().find((entry) => entry.includes("[email simulated]"));
  const match = line?.match(/(\d{6}) is your/);
  if (!match) throw new Error("no emailed code in log");
  return match[1]!;
}

describe("platform admin MFA", () => {
  it("leaves desk /login password-only", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, needsCode: false, user: { id: "m.costa", tenantId: "tnt-yorkfx" } });
    expect(start.json().step).toBeUndefined();
    expect(start.json().otpauthUri).toBeUndefined();
    expect(cookieOf(start)).toBeTruthy();

    const legacy = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().user.id).toBe("m.costa");
    expect(cookieOf(legacy)).toBeTruthy();

    const panel = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    expect(panel.statusCode).toBe(401);
    expect(panel.json().otpauthUri).toBeUndefined();
    expect(panel.json().backupCodes).toBeUndefined();
    expect(cookieOf(panel)).toBe("");
  });

  it("enrolls, rejects a bad code, accepts a good one, and burns a backup code", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { staffId: OPERATOR, password: PASSWORD },
    });
    expect(started.statusCode).toBe(200);
    expect(cookieOf(started)).toBe("");
    const body = started.json() as {
      step: string;
      ticket: string;
      otpauthUri: string;
      manualSecret: string;
      backupCodes: string[];
    };
    expect(body.step).toBe("enroll");
    expect(body.otpauthUri.startsWith("otpauth://totp/")).toBe(true);
    expect(body.backupCodes).toHaveLength(10);
    for (const code of body.backupCodes) expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);

    const totp = OTPAuth.URI.parse(body.otpauthUri);
    expect(totp).toBeInstanceOf(OTPAuth.TOTP);
    const authenticator = totp as OTPAuth.TOTP;
    expect(authenticator.issuer).toBe("CurrencyDesk");
    expect(authenticator.secret.base32).toBe(body.manualSecret);

    const pending = await handle.db.select().from(schema.platformMfaChallenges);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.secretEnc?.startsWith("aes-256-gcm$")).toBe(true);
    expect(pending[0]!.secretEnc).not.toContain(body.manualSecret);
    expect(pending[0]!.secretEnc).not.toContain("otpauth://");
    const pendingHashes = pending[0]!.backupHashes ?? [];
    expect(pendingHashes).toHaveLength(10);
    for (const hash of pendingHashes) {
      expect(hash.startsWith("scrypt$")).toBe(true);
      expect(hash).not.toContain(body.manualSecret);
    }
    for (const code of body.backupCodes) {
      expect(JSON.stringify(pendingHashes)).not.toContain(code);
      expect(JSON.stringify(pendingHashes)).not.toContain(code.replace("-", ""));
    }
    expect(logged.join("\n")).not.toContain(body.manualSecret);
    for (const code of body.backupCodes) expect(logged.join("\n")).not.toContain(code);

    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/login/enroll",
      payload: { ticket: body.ticket, code: rejectingCode(authenticator) },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("wrong_code");
    expect(cookieOf(bad)).toBe("");
    const stillOut = await handle.db.select({ at: schema.platformUsers.totpEnrolledAt }).from(schema.platformUsers).where(eq(schema.platformUsers.email, OPERATOR));
    expect(stillOut[0]?.at ?? null).toBeNull();

    const good = await app.inject({
      method: "POST",
      url: "/api/admin/login/enroll",
      payload: { ticket: body.ticket, code: authenticator.generate() },
    });
    expect(good.statusCode).toBe(200);
    expect(cookieOf(good)).toBeTruthy();
    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: cookieOf(good) } });
    expect(me.json()).toMatchObject({ isAdmin: true, mfaEnrolled: true, mfaRequired: false, email: OPERATOR });
    const stored = await handle.db.select().from(schema.platformUsers).where(eq(schema.platformUsers.email, OPERATOR));
    expect(stored[0]?.totpSecretEnc?.startsWith("aes-256-gcm$")).toBe(true);
    expect(stored[0]?.totpSecretEnc).not.toContain(body.manualSecret);
    const savedCodes = await handle.db.select().from(schema.platformMfaBackupCodes);
    expect(savedCodes).toHaveLength(10);
    expect(savedCodes.every((row) => row.usedAt === null && row.codeHash.startsWith("scrypt$"))).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { staffId: OPERATOR, password: PASSWORD },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().step).toBe("totp");
    expect(again.json().otpauthUri).toBeUndefined();
    expect(again.json().backupCodes).toBeUndefined();
    expect(again.json().manualSecret).toBeUndefined();
    expect(cookieOf(again)).toBe("");

    const wrongTotp = await app.inject({
      method: "POST",
      url: "/api/admin/login/totp",
      payload: { ticket: again.json().ticket, code: rejectingCode(authenticator) },
    });
    expect(wrongTotp.statusCode).toBe(401);
    expect(cookieOf(wrongTotp)).toBe("");

    const nextCode = authenticator.generate({ timestamp: Date.now() + 30_000 });
    const rightTotp = await app.inject({
      method: "POST",
      url: "/api/admin/login/totp",
      payload: { ticket: again.json().ticket, code: nextCode },
    });
    expect(rightTotp.statusCode).toBe(200);
    expect(cookieOf(rightTotp)).toBeTruthy();
    const tenants = await app.inject({ method: "GET", url: "/api/admin/tenants", headers: { cookie: cookieOf(rightTotp) } });
    expect(tenants.statusCode).toBe(200);

    const withBackup = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { staffId: OPERATOR, password: PASSWORD },
    });
    const used = body.backupCodes[0]!;
    const backup = await app.inject({
      method: "POST",
      url: "/api/admin/login/totp",
      payload: { ticket: withBackup.json().ticket, code: used },
    });
    expect(backup.statusCode).toBe(200);
    expect(cookieOf(backup)).toBeTruthy();

    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { staffId: OPERATOR, password: PASSWORD },
    });
    const burned = await app.inject({
      method: "POST",
      url: "/api/admin/login/totp",
      payload: { ticket: replay.json().ticket, code: used },
    });
    expect(burned.statusCode).toBe(401);
    expect(burned.json().error).toBe("wrong_code");
    expect(cookieOf(burned)).toBe("");
    const spent = await handle.db.select().from(schema.platformMfaBackupCodes);
    expect(spent.filter((row) => row.usedAt !== null)).toHaveLength(1);

    const other = await app.inject({
      method: "POST",
      url: "/api/admin/login/totp",
      payload: { ticket: replay.json().ticket, code: body.backupCodes[1] },
    });
    expect(other.statusCode).toBe(200);

    /* The desk emailed-code door still signs the person in. It must not
       open the panel once an authenticator is enrolled. */
    forgetCooldown();
    const deskStart = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      payload: { staffId: OPERATOR, password: PASSWORD },
    });
    expect(deskStart.statusCode).toBe(200);
    expect(deskStart.json().needsCode).toBe(true);
    expect(cookieOf(deskStart)).toBe("");
    const deskSession = await app.inject({
      method: "POST",
      url: "/api/auth/login/verify",
      payload: { staffId: OPERATOR, code: codeFromLog() },
    });
    expect(deskSession.statusCode).toBe(200);
    expect(cookieOf(deskSession)).toBeTruthy();
    const deskMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(deskSession) } });
    expect(deskMe.statusCode).toBe(200);
    expect(deskMe.json().user.id).toBe(OPERATOR);
    const blocked = await app.inject({ method: "GET", url: "/api/admin/tenants", headers: { cookie: cookieOf(deskSession) } });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe("mfa_required");

    const trail = logged.join("\n");
    expect(trail).not.toContain(body.manualSecret);
    for (const code of body.backupCodes) expect(trail).not.toContain(code);
  }, 60_000);

  it("opens a panel session for a desk staff id that owns the platform", async () => {
    await handle.db.insert(schema.platformUsers).values({
      email: "j.masri",
      role: "support",
      status: "active",
      addedBy: "test",
    }).onConflictDoNothing();
    const start = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    expect(start.statusCode).toBe(200);
    const body = start.json() as { step: string; ticket: string; otpauthUri: string };
    expect(body.step).toBe("enroll");
    const authenticator = OTPAuth.URI.parse(body.otpauthUri) as OTPAuth.TOTP;
    const enrolled = await app.inject({
      method: "POST",
      url: "/api/admin/login/enroll",
      payload: { ticket: body.ticket, code: authenticator.generate() },
    });
    expect(enrolled.statusCode).toBe(200);
    expect(cookieOf(enrolled)).toBeTruthy();
    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: cookieOf(enrolled) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().isAdmin).toBe(true);
    expect(me.json().mfaEnrolled).toBe(true);

    const desk = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    expect(desk.statusCode).toBe(200);
    const blocked = await app.inject({ method: "GET", url: "/api/admin/tenants", headers: { cookie: cookieOf(desk) } });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe("mfa_required");
  }, 60_000);
});

describe("TOTP key", () => {
  const prior = {
    node: process.env.NODE_ENV,
    key: process.env.PLATFORM_MFA_KEY,
    database: process.env.DATABASE_URL,
  };
  afterAll(() => {
    if (prior.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.node;
    if (prior.key === undefined) delete process.env.PLATFORM_MFA_KEY;
    else process.env.PLATFORM_MFA_KEY = prior.key;
    if (prior.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior.database;
  });

  it("does not derive the pepper from DATABASE_URL, in production or beside a seam database", async () => {
    const plain = "JBSWY3DPEHPK3PXP";
    delete process.env.PLATFORM_MFA_KEY;
    delete process.env.NODE_ENV;
    process.env.DATABASE_URL = "postgres://seam-user:seam-secret@localhost/currencydesk_seam";
    const stored = await encryptSecret(plain);
    delete process.env.DATABASE_URL;
    expect(await decryptSecret(stored)).toBe(plain);

    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://prod-user:prod-secret@localhost/currencydesk";
    await expect(encryptSecret(plain)).rejects.toThrow("mfa_key_unavailable");

    process.env.PLATFORM_MFA_KEY = "dedicated-test-key";
    const keyed = await encryptSecret(plain);
    process.env.DATABASE_URL = "postgres://rotated@localhost/other";
    expect(await decryptSecret(keyed)).toBe(plain);
    delete process.env.PLATFORM_MFA_KEY;
    await expect(decryptSecret(keyed)).rejects.toThrow("mfa_secret_unreadable");
  });
});
