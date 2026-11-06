/* ============================================================
   A PIN proves one action, once (CD-140, GitHub #630, PR 2).

   POST /api/staff/pin/verify used to answer { ok } and nothing bound
   that answer to anything: the desk decided what the PIN had just
   approved, so the step-up was enforced in the browser only. With an
   action and a target the route now mints a random token, stored
   hashed, bound to that action, that target, the shop and the PIN's
   owner, good for about two minutes and usable once. The route that
   performs the action consumes it on the server. Reuse, the wrong
   action, the wrong target, another shop, an expired token and the
   maker as their own approver are all refused. A default or weak PIN
   (the staging 0000) opens the ordinary gate as before but mints no
   token: it proves nothing about who is at the keypad.
   ============================================================ */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/routes/pin.js";
import { consumeStepUp, STEP_UP_SECONDS } from "../src/routes/step-up.js";

let handle: DbHandle;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
const idOf = (staffId: string) => `${DEMO.tenantId}:${staffId}`;
const ACTION = "till.handover.approve";
const TARGET = "till_session_abc";

async function signIn(staffId: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: "yorkville", tenantId: DEMO.tenantId } });
  expect(res.statusCode, res.body).toBe(200);
  return { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value };
}
const verify = (who: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: cookies[who], payload });
const rows = () => handle.db.select().from(schema.staffStepUpTokens);
const sha = (token: string) => createHash("sha256").update(token).digest("hex");

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const pins: Array<[string, string]> = [["r.haddad", "4829"], ["m.costa", "7316"]];
  for (const [who, pin] of pins) {
    cookies[who] = await signIn(who);
    const set = await app.inject({ method: "POST", url: "/api/staff/pin", cookies: cookies[who], payload: { pin } });
    expect(set.statusCode, set.body).toBe(200);
  }
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });

describe("minting", () => {
  it("without an action answers as before and mints nothing", async () => {
    const res = await verify("r.haddad", { pin: "4829" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, mustChange: false });
    expect(await rows()).toHaveLength(0);
  });

  it("with an action and a target mints a token bound to them, stored hashed, good for about two minutes", async () => {
    const before = Date.now();
    const res = await verify("r.haddad", { pin: "4829", action: ACTION, target: TARGET });
    expect(res.statusCode, res.body).toBe(200);
    const { token, expiresAt } = res.json() as { token: string; expiresAt: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const ttl = (new Date(expiresAt).getTime() - before) / 1000;
    expect(ttl).toBeGreaterThan(STEP_UP_SECONDS - 10);
    expect(ttl).toBeLessThan(STEP_UP_SECONDS + 10);
    const [row] = await rows();
    expect(row).toMatchObject({ tenantId: DEMO.tenantId, staffId: idOf("r.haddad"), issuedBy: idOf("r.haddad"), action: ACTION, targetId: TARGET, usedAt: null });
    expect(row!.tokenHash).toBe(sha(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("a wrong PIN mints nothing", async () => {
    const n = (await rows()).length;
    const res = await verify("r.haddad", { pin: "1111", action: ACTION, target: TARGET });
    expect(res.statusCode).toBe(401);
    expect((await rows()).length).toBe(n);
  });

  it("an action needs a target, and only a known action is accepted", async () => {
    expect((await verify("r.haddad", { pin: "4829", action: ACTION })).statusCode).toBe(400);
    expect((await verify("r.haddad", { pin: "4829", action: "anything", target: TARGET })).statusCode).toBe(400);
  });

  it("a default or weak PIN opens the ordinary gate but mints no token, and so does a PIN that must be changed", async () => {
    const costa = idOf("m.costa");
    await handle.db.update(schema.staffUsers).set({ pinHash: await hashPin("0000") }).where(eq(schema.staffUsers.id, costa));
    try {
      expect((await verify("m.costa", { pin: "0000" })).statusCode).toBe(200);
      const refused = await verify("m.costa", { pin: "0000", action: ACTION, target: TARGET });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("default_pin");
    } finally {
      await handle.db.update(schema.staffUsers).set({ pinHash: await hashPin("7316") }).where(eq(schema.staffUsers.id, costa));
    }
    await handle.db.update(schema.staffUsers).set({ pinMustChange: true }).where(eq(schema.staffUsers.id, costa));
    try {
      const refused = await verify("m.costa", { pin: "7316", action: ACTION, target: TARGET });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("pin_must_change");
    } finally {
      await handle.db.update(schema.staffUsers).set({ pinMustChange: false }).where(eq(schema.staffUsers.id, costa));
    }
    expect((await rows()).filter((r) => r.staffId === costa)).toHaveLength(0);
  });
});

describe("consuming", () => {
  const mint = async (who = "r.haddad", pin = "4829", target = TARGET) => {
    const res = await verify(who, { pin, action: ACTION, target });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  };
  const use = (token: string, over: Partial<{ action: string; target: string; tenantId: string; byStaffId: string }> = {}) =>
    consumeStepUp(handle.db, { token, action: ACTION, target: TARGET, tenantId: DEMO.tenantId, byStaffId: idOf("m.costa"), ...over });

  it("works once, names the PIN's owner, and a second use is refused", async () => {
    const token = await mint();
    expect(await use(token)).toEqual({ ok: true, staffId: idOf("r.haddad") });
    expect(await use(token)).toEqual({ ok: false, reason: "used" });
  });

  it("the wrong action, the wrong target, another shop and an unknown token are refused, and the token is not spent by the refusal", async () => {
    const token = await mint();
    expect(await use(token, { action: "transaction.void" })).toEqual({ ok: false, reason: "wrong_action" });
    expect(await use(token, { target: "till_session_other" })).toEqual({ ok: false, reason: "wrong_target" });
    expect(await use(token, { tenantId: "tnt-other" })).toEqual({ ok: false, reason: "wrong_tenant" });
    expect(await use("f".repeat(64))).toEqual({ ok: false, reason: "unknown" });
    expect(await use(token)).toEqual({ ok: true, staffId: idOf("r.haddad") });
  });

  it("an expired token is refused", async () => {
    const token = await mint();
    await handle.db.update(schema.staffStepUpTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.staffStepUpTokens.tokenHash, sha(token)));
    expect(await use(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("the maker cannot be the approver: a token the taker minted for themselves is refused at use", async () => {
    const token = await mint("m.costa", "7316");
    expect(await use(token, { byStaffId: idOf("m.costa") })).toEqual({ ok: false, reason: "self" });
    /* Somebody else's action, approved by m.costa, is fine. */
    expect(await use(token, { byStaffId: idOf("r.haddad") })).toEqual({ ok: true, staffId: idOf("m.costa") });
  });
});
