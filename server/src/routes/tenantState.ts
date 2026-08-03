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
import { BODY_LIMIT_BYTES, MAX_STATE_BYTES, WARN_AT_BYTES, tooLarge } from "../state/contract.js";
import { describe as describeState, summarise } from "../state/shape.js";

/* What we last said about each desk's document, so a save every four
   seconds does not become a log line every four seconds. Only a CHANGE in
   what is wrong is worth writing down.

   In memory, and therefore per process — the same assumption four other
   things in this codebase make (see docs/ARCHITECTURE.md §8). For log
   de-duplication that costs nothing if it is wrong: a restart writes one
   extra line. */
const lastSaid = new Map<string, string>();

const putBody = z.object({
  state: z.record(z.unknown()),
  /* The version this save was built on. Optional only while browsers opened
     before this shipped are still running — see the PUT handler. */
  version: z.number().int().nonnegative().optional(),
});

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
    if (!row) return { state: null, updatedAt: null, version: 0 };
    return { state: row.state, updatedAt: row.updatedAt, version: row.version };
  });

  /* The route carries its own body limit, above the guard below, so that a
     document over the line is refused by US — with its actual size and what
     to do about it — instead of by Fastify's generic 413, which tells a
     client nothing it can act on. See src/state/contract.ts. */
  app.put("/api/tenant/state", { bodyLimit: BODY_LIMIT_BYTES }, async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = putBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const state = parsed.data.state;

    const bytes = Buffer.byteLength(JSON.stringify(state));
    if (bytes > MAX_STATE_BYTES) {
      /* Logged, because this is the failure that used to happen in silence.
         A desk in this state cannot save at all and nobody was finding out. */
      req.log.error({ tenantId: who.tenantId, bytes, limit: MAX_STATE_BYTES }, "desk state over the limit — nothing saved");
      return reply.code(413).send(tooLarge(bytes));
    }

    /* ---- has somebody else written since this browser last read? --------

       Every teller's browser holds a whole copy of this document and writes
       it back entire. Without a precondition the last writer wins and the
       other one's work is gone — no error, no log, nothing on screen. Two
       people on one desk is not an exotic case, it is a Saturday.

       So a save carries the version it was built on. If the stored version
       has moved, this save is refused and the current document is handed
       back, so the client can merge key by key (see cdos-persist.js) rather
       than either side losing everything.

       A save with NO version behaves exactly as before. That is deliberate
       and temporary: a browser that was already open when this deployed is
       still running the old bridge, and breaking its saves to fix a race is
       a bad trade. It is logged so we can see when the last one is gone,
       and then this branch becomes a 400. */
    const current = (await db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, who.tenantId)).limit(1))[0];
    const expected = parsed.data.version;
    if (expected === undefined) {
      req.log.warn({ tenantId: who.tenantId }, "desk state saved without a version — an old client is still open");
    } else if (current && current.version !== expected) {
      return reply.code(409).send({
        error: "state_conflict",
        detail: "Somebody else saved this desk while you were working. Merging.",
        state: current.state,
        version: current.version,
      });
    }

    /* Describe what is being saved. This NEVER refuses — the browser holds
       the only copy, so rejecting a document we merely find surprising
       destroys the data it was meant to protect. What it does is make drift
       a fact somebody can read instead of something nobody can see. See
       src/state/shape.ts for why that trade goes this way round. */
    const report = describeState(state);
    const said = summarise(report);
    if (lastSaid.get(who.tenantId) !== said) {
      lastSaid.set(who.tenantId, said);
      const notable = report.unknown.length > 0 || report.invalid.length > 0;
      req.log[notable ? "warn" : "info"](
        { tenantId: who.tenantId, unknown: report.unknown, invalid: report.invalid, recordBytes: report.recordBytes },
        `desk state: ${said}`,
      );
    }

    // mutates `state`: any till PIN in the blob moves to the staff record
    await absorbStaffPins(db, who.tenantId, state);
    const now = new Date();
    const version = (current?.version ?? 0) + 1;
    await db
      .insert(schema.tenantState)
      .values({ tenantId: who.tenantId, state, updatedBy: who.id, updatedAt: now, version })
      .onConflictDoUpdate({ target: schema.tenantState.tenantId, set: { state, updatedBy: who.id, updatedAt: now, version } });
    /* Say how close they are while there is still room to act. The client
       surfaces this once rather than every four seconds. */
    return {
      ok: true,
      updatedAt: now.toISOString(),
      version,
      bytes,
      ...(bytes > WARN_AT_BYTES ? { nearingLimit: true, limit: MAX_STATE_BYTES } : {}),
    };
  });
}
