/* CD-273 step-up, owner authenticator, recovery codes, and session revoke. */
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
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
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

    const factor = await verifyOwnerFactor(handle.db, user, body.backupCodes[0]!);
    expect(factor).toBe("backup");
    expect(await verifyOwnerFactor(handle.db, user, body.backupCodes[0]!)).toBeNull();
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
});
