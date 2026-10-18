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
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { canWriteSetting, CHEQUE_FEE_SCHEDULE_KEY } from "../auth/settingsWrite.js";
import { feeFigureProblem } from "../ledger/chequeFee.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { hashPin } from "./pin.js";
import { BODY_LIMIT_BYTES, MAX_STATE_BYTES, WARN_AT_BYTES, tooLarge } from "../state/contract.js";
import { describe as describeState, summarise } from "../state/shape.js";

/* The cheque fee is the price of the desk's own credit. Who may write
   it lives in canWriteSetting, not in a role list at this route. */
export { CHEQUE_FEE_SCHEDULE_KEY };
export const CHEQUE_FEE_REFUSAL =
  "Only the owner or a manager can change cheque fees. Ask a manager to make this change.";

/* A figure on the way in. Booking still reads an older stored percent
   and rounds it. This refusal is the save, never the cashing. */
export const FEE_PERCENT_PLACES =
  "That change didn't save. A fee % can have up to 2 decimals, like 2.25.";
export const FEE_MIN_PLACES =
  "That change didn't save. A minimum fee can have up to 2 decimals, like 4.00.";
export const FEE_MAX_PLACES =
  "That change didn't save. A maximum fee can have up to 2 decimals, like 4.00.";

/* The schedule the capture screen ships. A first save of exactly this
   is the desk opening, not a price change, so a teller may store it.
   Anything else is a change and needs the owner or a manager. */
export const DEFAULT_CHEQUE_SCHEDULE = [
  { id: "government", label: "Government", feePct: 1.5, feeMin: 4, holdDays: 0, risk: "low" },
  { id: "payroll", label: "Payroll", feePct: 2, feeMin: 5, holdDays: 1, risk: "low" },
  { id: "certified", label: "Certified / bank draft", feePct: 1, feeMin: 5, holdDays: 0, risk: "low" },
  { id: "money_order", label: "Money order", feePct: 1.5, feeMin: 4, holdDays: 0, risk: "low" },
  { id: "business", label: "Business", feePct: 3, feeMin: 10, holdDays: 3, risk: "medium" },
  { id: "personal", label: "Personal", feePct: 3.5, feeMin: 10, holdDays: 5, risk: "high" },
];

function canonSchedule(value: unknown): string | null {
  if (value == null) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return JSON.stringify(parsed);
}

/* True when this save would change the stored fee schedule.
   Omitting the key replaces the whole document, which deletes the
   schedule, and that is a write. A string that is not JSON is still
   an attempt to write the key. A SyntaxError is that attempt, not a
   failure to hide: every other error is rethrown. */
export function chequeScheduleWrite(stored: Record<string, unknown> | null, incoming: Record<string, unknown> | null): boolean {
  const prev = stored ? stored[CHEQUE_FEE_SCHEDULE_KEY] : undefined;
  if (!incoming || !(CHEQUE_FEE_SCHEDULE_KEY in incoming)) return prev != null;
  const next = incoming[CHEQUE_FEE_SCHEDULE_KEY];
  let nextCanon: string | null;
  let prevCanon: string | null;
  try {
    nextCanon = canonSchedule(next);
    prevCanon = prev == null ? null : canonSchedule(prev);
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    throw error;
  }
  if (nextCanon === prevCanon) return false;
  if (prev == null && nextCanon === JSON.stringify(DEFAULT_CHEQUE_SCHEDULE)) return false;
  return true;
}

/* One row per cheque type, so the audit can show the old price and
   the new one. A string that is not JSON is stored as itself. */
function feeRows(value: unknown): unknown {
  if (value == null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch (error) {
      if (error instanceof SyntaxError) return value;
      throw error;
    }
  }
  if (!Array.isArray(parsed)) return parsed;
  return parsed.map((row) => {
    if (!row || typeof row !== "object") return row;
    const item = row as Record<string, unknown>;
    return { id: item.id, label: item.label, feePct: item.feePct, feeMin: item.feeMin, holdDays: item.holdDays, risk: item.risk };
  });
}

/* A stale tab sends the version it loaded. Anything else, including a
   body that is not valid yet, is not a version conflict. */
function sentVersion(body: Record<string, unknown> | null): number | undefined {
  const version = body?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return undefined;
  return version;
}

function stateConflict(row: { state: unknown; version: number } | undefined) {
  return {
    error: "state_conflict",
    detail: "Somebody else saved this desk while you were working. Merging.",
    state: row?.state ?? null,
    version: row?.version ?? 0,
  };
}

/* The first fee figure this save cannot store. "places" is more than 2
   digits after the point. "unread" is a figure booking cannot price,
   including "4." and ".". Both use the same reader as booking. The field
   name is feePct, feeMin, or feeMax. A string that is not JSON is not
   this refusal. */
export function scheduleFigureOverTwo(state: Record<string, unknown> | null): { field: string; id: string; detail: string } | null {
  if (!state || !(CHEQUE_FEE_SCHEDULE_KEY in state)) return null;
  const raw = state[CHEQUE_FEE_SCHEDULE_KEY];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); }
    catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  if (!Array.isArray(parsed)) return null;
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const item = row as { id?: unknown; feePct?: unknown; feeMin?: unknown; feeMax?: unknown };
    const id = item.id == null ? "" : String(item.id);
    if (feeFigureProblem(item.feePct, "percent")) return { field: "feePct", id, detail: FEE_PERCENT_PLACES };
    if ("feeMin" in item && feeFigureProblem(item.feeMin, "money")) return { field: "feeMin", id, detail: FEE_MIN_PLACES };
    if ("feeMax" in item && feeFigureProblem(item.feeMax, "money")) return { field: "feeMax", id, detail: FEE_MAX_PLACES };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

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
    /* The need is decided from the raw body, and it is checked before
       Zod. A caller who may not change the fee is told that, including
       when the rest of the body is the wrong shape. They do not get a
       400 that describes the document. */
    const raw = asRecord(req.body);
    const current = (await db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, who.tenantId)).limit(1))[0];
    /* The version is the first answer. A tab loaded before someone else
       saved is 409, the same shape as any other stale desk save, and it
       is not a permission refusal. A save with no version that would change the fee is that same 409, and it writes no refusal row. */
    const sent = sentVersion(raw);
    if (sent !== undefined && (current?.version ?? 0) !== sent) {
      return reply.code(409).send(stateConflict(current));
    }
    const mayWriteFees = canWriteSetting(who.role, CHEQUE_FEE_SCHEDULE_KEY);
    const changingFees = chequeScheduleWrite(asRecord(current?.state), asRecord(raw?.state));
    if (changingFees && raw?.version == null) return reply.code(409).send(stateConflict(current));
    if (changingFees && !mayWriteFees) {
      await audit(db, {
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId: who.branchId,
        actorId: who.id,
        action: "settings.cheque_fee_refused",
        detail: { key: CHEQUE_FEE_SCHEDULE_KEY, role: who.role, staffId: who.staffId, name: who.name },
      });
      return reply.code(403).send({ error: "permission_denied", detail: CHEQUE_FEE_REFUSAL });
    }
    const overTwo = changingFees ? scheduleFigureOverTwo(asRecord(raw?.state)) : null;
    if (overTwo) {
      return reply.code(400).send({ error: "fee_places", field: overTwo.field, id: overTwo.id, detail: overTwo.detail });
    }
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
       than either side losing everything. A save with no version may still write the desk, but the update matches only when the stored fee text is unchanged. */
    const expected = parsed.data.version;
    if (expected === undefined) {
      req.log.warn({ tenantId: who.tenantId }, "desk state saved without a version — an old client is still open");
    } else if ((current?.version ?? 0) !== expected) {
      return reply.code(409).send(stateConflict(current));
    }
    /* A teller's document carries a copy of the fee key. That copy is
       not the price. The stored key is. */
    if (!mayWriteFees) {
      const stored = asRecord(current?.state);
      if (stored && CHEQUE_FEE_SCHEDULE_KEY in stored) state[CHEQUE_FEE_SCHEDULE_KEY] = stored[CHEQUE_FEE_SCHEDULE_KEY];
      else delete state[CHEQUE_FEE_SCHEDULE_KEY];
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
    /* The predicate is the race. Two saves can both have read version N.
       Only one update matches N. The other is 409 and writes nothing. */
    const written = current
      ? await db
        .update(schema.tenantState)
        .set({ state, updatedBy: who.id, updatedAt: now, version })
        .where(and(
          eq(schema.tenantState.tenantId, who.tenantId),
          expected === undefined ? sql`(${schema.tenantState.state} ->> ${CHEQUE_FEE_SCHEDULE_KEY}) is not distinct from ${typeof state[CHEQUE_FEE_SCHEDULE_KEY] === "string" ? state[CHEQUE_FEE_SCHEDULE_KEY] : state[CHEQUE_FEE_SCHEDULE_KEY] == null ? null : JSON.stringify(state[CHEQUE_FEE_SCHEDULE_KEY])}` : eq(schema.tenantState.version, expected),
        ))
        .returning()
      : await db
        .insert(schema.tenantState)
        .values({ tenantId: who.tenantId, state, updatedBy: who.id, updatedAt: now, version })
        .onConflictDoNothing({ target: schema.tenantState.tenantId })
        .returning();
    if (!written.length) {
      const fresh = (await db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, who.tenantId)).limit(1))[0];
      return reply.code(409).send(stateConflict(fresh));
    }
    /* A change that landed. Who, when (`at` on the row), and the
       price of each cheque type before and after. */
    if (changingFees) {
      const prev = asRecord(current?.state);
      await audit(db, {
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId: who.branchId,
        actorId: who.id,
        action: "settings.cheque_fee_changed",
        detail: {
          staffId: who.staffId,
          name: who.name,
          role: who.role,
          before: feeRows(prev ? prev[CHEQUE_FEE_SCHEDULE_KEY] : null),
          after: feeRows(state[CHEQUE_FEE_SCHEDULE_KEY]),
        },
      });
    }
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
