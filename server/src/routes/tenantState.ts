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
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";

// a working desk's snapshot is well under this; guards against a runaway client
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const putBody = z.object({ state: z.record(z.unknown()) });

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
    const now = new Date();
    await db
      .insert(schema.tenantState)
      .values({ tenantId: who.tenantId, state, updatedBy: who.id, updatedAt: now })
      .onConflictDoUpdate({ target: schema.tenantState.tenantId, set: { state, updatedBy: who.id, updatedAt: now } });
    return { ok: true, updatedAt: now.toISOString() };
  });
}
