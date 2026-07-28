/* ============================================================
   Staff PINs — the 4-digit code that confirms it is really you before
   you take a drawer, switch accounts, or void a ticket.

     POST /api/staff/pin/verify   { staffId?, pin }  → { ok }
     POST /api/staff/pin          { pin, currentPin? }  → set your own
     POST /api/staff/pin/reset    { password, pin }     → forgot it

   A PIN is personal — it is how the ledger knows a drawer was taken by
   YOU. So forgetting it must not mean asking the owner for one, because
   then the owner knows it too and can act as you. Anyone signed in can
   prove themselves with their sign-in password and choose a new PIN that
   nobody else ever sees.

   A PIN somebody else issued is marked must-change for the same reason:
   it is a way back in, not an identity, and it stops being shared
   knowledge the moment its owner picks their own.

   The desk used to hold the expected PIN in the browser and compare it
   there, which made the gate decorative: anyone with devtools could read
   it or skip it. The PIN now lives here, hashed, and only the server
   ever says whether one is right.

   Four digits is ten thousand guesses, so verification is rate-limited
   per person and locks out for a spell after a run of wrong ones. That
   lockout is deliberately in memory: it costs a restart to clear, which
   is the right trade for a control whose job is to stop someone leaning
   on a keypad, not to survive a determined attacker with database
   access — they would have won already.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";

const PIN = z.string().regex(/^\d{4}$/, "pin: four digits");
const verifyBody = z.object({ staffId: z.string().min(1).max(120).optional(), pin: PIN });
const setBody = z.object({ pin: PIN, currentPin: PIN.optional() });
const resetBody = z.object({ password: z.string().min(1).max(512), pin: PIN });

const MAX_TRIES = 5;
const LOCK_MS = 5 * 60 * 1000;
const tries = new Map<string, { count: number; until: number }>();

function lockState(userId: string): { locked: boolean; remaining: number } {
  const t = tries.get(userId);
  if (!t) return { locked: false, remaining: MAX_TRIES };
  if (t.until > Date.now()) return { locked: true, remaining: 0 };
  if (t.until) { tries.delete(userId); return { locked: false, remaining: MAX_TRIES }; }
  return { locked: false, remaining: Math.max(0, MAX_TRIES - t.count) };
}
function recordFailure(userId: string): { locked: boolean; remaining: number } {
  const t = tries.get(userId) ?? { count: 0, until: 0 };
  t.count += 1;
  if (t.count >= MAX_TRIES) { t.until = Date.now() + LOCK_MS; t.count = 0; }
  tries.set(userId, t);
  return lockState(userId);
}
export const clearPinAttempts = (userId: string): void => { tries.delete(userId); };

/* What support sees when somebody rings up unable to get in: whether the
   keypad is shut, and for how long. Without this the panel can only guess. */
export function pinLockedUntil(userId: string): string | null {
  const t = tries.get(userId);
  return t && t.until > Date.now() ? new Date(t.until).toISOString() : null;
}

/* A PIN nobody would pick: not a repeat, not a run, not a date. Those are
   the first things guessed, and a code the desk issues should never be one. */
export function generatePin(): string {
  for (;;) {
    const bytes = new Uint32Array(1);
    globalThis.crypto.getRandomValues(bytes);
    const pin = String(bytes[0]! % 10000).padStart(4, "0");
    const d = pin.split("").map(Number) as number[];
    const allSame = d.every((x) => x === d[0]);
    const ascending = d.every((x, i) => i === 0 || x === (d[i - 1]! + 1) % 10);
    const descending = d.every((x, i) => i === 0 || x === (d[i - 1]! + 9) % 10);
    const looksLikeYear = pin.startsWith("19") || pin.startsWith("20");
    if (!allSame && !ascending && !descending && !looksLikeYear) return pin;
  }
}

export const hashPin = (pin: string) => hashPassword(pin);

export function registerPinRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/staff/pin/verify", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    /* Switching accounts means proving somebody else's PIN, so a staff id may
       be named — but only within the caller's own desk. */
    const target = parsed.data.staffId
      ? (await db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.tenantId, who.tenantId), eq(schema.staffUsers.staffId, parsed.data.staffId))).limit(1))[0]
      : (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, who.id)).limit(1))[0];
    if (!target || !target.active) return reply.code(404).send({ error: "not_found" });

    // no PIN on file: say so plainly rather than failing, so the desk can fall
    // back to its own check until this desk's PINs have been set here
    if (!target.pinHash) return reply.code(409).send({ error: "no_pin", detail: "No PIN is set for this person." });

    const state = lockState(target.id);
    if (state.locked) {
      return reply.code(429).send({ error: "locked", detail: "Too many wrong PINs. Try again in a few minutes." });
    }
    if (await verifyPassword(parsed.data.pin, target.pinHash)) {
      clearPinAttempts(target.id);
      // the gate opens either way; the desk uses this to ask them to pick
      // their own afterwards rather than interrupting a customer mid-deal
      return { ok: true, mustChange: target.pinMustChange };
    }
    const after = recordFailure(target.id);
    await audit(db, {
      tenantId: target.tenantId, legalEntityId: target.legalEntityId, branchId: target.branchId,
      actorId: who.id, action: "pin.failed", detail: { of: target.staffId },
    });
    return reply.code(401).send({ error: "wrong_pin", remaining: after.remaining, locked: after.locked });
  });

  // whether you have one, so the desk can offer "Set" or "Change" honestly.
  // Never the PIN itself, and never anyone else's.
  app.get("/api/staff/pin", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const me = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, who.id)).limit(1))[0];
    if (!me) return reply.code(404).send({ error: "not_found" });
    return { hasPin: !!me.pinHash, setAt: me.pinSetAt ?? null, mustChange: me.pinMustChange };
  });

  // set your own — proving the current one if you already have one
  app.post("/api/staff/pin", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = setBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const me = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, who.id)).limit(1))[0];
    if (!me) return reply.code(404).send({ error: "not_found" });
    if (me.pinHash) {
      if (!parsed.data.currentPin) return reply.code(400).send({ error: "current_required", detail: "Enter your current PIN." });
      if (lockState(me.id).locked) return reply.code(429).send({ error: "locked", detail: "Too many wrong PINs. Try again in a few minutes." });
      if (!(await verifyPassword(parsed.data.currentPin, me.pinHash))) {
        recordFailure(me.id);
        return reply.code(401).send({ error: "wrong_pin" });
      }
    }
    await db.update(schema.staffUsers)
      .set({ pinHash: await hashPin(parsed.data.pin), pinSetAt: new Date(), pinMustChange: false })
      .where(eq(schema.staffUsers.id, me.id));
    clearPinAttempts(me.id);
    await audit(db, {
      tenantId: me.tenantId, legalEntityId: me.legalEntityId, branchId: me.branchId,
      actorId: me.id, action: "pin.set",
    });
    return { ok: true };
  });

  /* Forgot it. Your sign-in password is something the owner does not have,
     so it is the right thing to prove here — it lets you back in without
     anyone else ever learning the PIN you end up with.

     Wrong passwords count against the same lockout as wrong PINs: this is
     the one door left when the keypad is shut, so it cannot be a quieter
     way to stand at that keypad. */
  app.post("/api/staff/pin/reset", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const me = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, who.id)).limit(1))[0];
    if (!me) return reply.code(404).send({ error: "not_found" });
    if (lockState(me.id).locked) return reply.code(429).send({ error: "locked", detail: "Too many wrong tries. Try again in a few minutes." });
    if (!(await verifyPassword(parsed.data.password, me.passwordHash))) {
      recordFailure(me.id);
      await audit(db, {
        tenantId: me.tenantId, legalEntityId: me.legalEntityId, branchId: me.branchId,
        actorId: me.id, action: "pin.reset_failed",
      });
      return reply.code(401).send({ error: "wrong_password", detail: "That is not your sign-in password." });
    }

    await db.update(schema.staffUsers)
      .set({ pinHash: await hashPin(parsed.data.pin), pinSetAt: new Date(), pinMustChange: false })
      .where(eq(schema.staffUsers.id, me.id));
    clearPinAttempts(me.id);
    await audit(db, {
      tenantId: me.tenantId, legalEntityId: me.legalEntityId, branchId: me.branchId,
      actorId: me.id, action: "pin.self_reset",
    });
    return { ok: true };
  });
}
