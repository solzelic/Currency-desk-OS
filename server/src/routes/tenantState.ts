/* ============================================================
   Tenant state — the OS's per-desk working state, saved server-side.
     GET /api/tenant/state  → { state, updatedAt }   (null when never saved)
     PUT /api/tenant/state   { state } → upsert, scoped to the caller's tenant
   This is what makes a signed-up desk REAL: the OS hydrates its ~30 browser
   keys from this snapshot on sign-in and writes it back (debounced) as the
   desk is used. Always scoped to the session's own tenant — a client can
   never read or write another tenant's state.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { hashPin } from "./pin.js";

// a working desk's snapshot is well under this; guards against a runaway client
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const putBody = z.object({ state: z.record(z.unknown()) });

/* The desk's settings used to carry every teller's till PIN in the clear,
   inside this very snapshot — which the browser downloads whole on sign-in.
   Anyone who could open devtools could read the room's PINs.

   So the snapshot is no longer allowed to hold one. On the way in, a PIN
   somebody has genuinely chosen is moved to their staff record, hashed; the
   placeholder the OS ships with ("0000", the same for everyone) is dropped
   rather than adopted, so the panel goes on saying "no PIN set" — which is
   the truth — instead of recording a code the whole desk knows.

   Either way the plaintext is stripped before anything is stored. This runs
   on every save, so a desk migrates the first time it is used and stays
   clean afterwards even if an older client keeps sending the field. */
const PLACEHOLDER_PIN = "0000";

async function absorbStaffPins(db: Db, tenantId: string, state: Record<string, unknown>): Promise<number> {
  const settings = state.cdos_settings;
  if (!settings || typeof settings !== "object") return 0;
  const employees = (settings as Record<string, unknown>).employees;
  if (!Array.isArray(employees)) return 0;

  let absorbed = 0;
  for (const emp of employees) {
    if (!emp || typeof emp !== "object") continue;
    const e = emp as Record<string, unknown>;
    const pin = typeof e.pin === "string" ? e.pin : null;
    delete e.pin;
    if (!pin || !/^\d{4}$/.test(pin) || pin === PLACEHOLDER_PIN) continue;

    // employees are keyed by their sign-in code; fall back to the name, which
    // is what the OS's own seeded roster matches on
    const code = typeof e.code === "string" ? e.code : null;
    const name = typeof e.name === "string" ? e.name : null;
    const rows = code
      ? await db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, code))).limit(1)
      : name
        ? await db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.name, name))).limit(1)
        : [];
    const target = rows[0];
    // never overwrite a PIN already held here — the server's copy is the real
    // one, and a stale blob must not be able to roll it back
    if (!target || target.pinHash) continue;
    await db.update(schema.staffUsers).set({ pinHash: await hashPin(pin), pinSetAt: new Date() }).where(eq(schema.staffUsers.id, target.id));
    absorbed += 1;
  }
  return absorbed;
}

export function registerTenantStateRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/tenant/state", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const rows = await db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, who.tenantId)).limit(1);
    const row = rows[0];
    if (!row) return { state: null, updatedAt: null };
    return { state: row.state, updatedAt: row.updatedAt };
  });

  app.put("/api/tenant/state", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = putBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const state = parsed.data.state;
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) {
      return reply.code(413).send({ error: "state_too_large", detail: "Desk state exceeds the size limit." });
    }
    // mutates `state`: any till PIN in the blob moves to the staff record
    await absorbStaffPins(db, who.tenantId, state);
    const now = new Date();
    await db
      .insert(schema.tenantState)
      .values({ tenantId: who.tenantId, state, updatedBy: who.id, updatedAt: now })
      .onConflictDoUpdate({ target: schema.tenantState.tenantId, set: { state, updatedBy: who.id, updatedAt: now } });
    return { ok: true, updatedAt: now.toISOString() };
  });
}
