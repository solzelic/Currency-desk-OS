/* ============================================================
   Locations and tills — the desk's own shape, on the server.

     GET  /api/desk/branches                    → every location + its tills
     POST /api/desk/branches                    → open a location
     POST /api/desk/branches/:branchId/tills    → put another till in one

   The screen calls these "locations"; the tables have always called them
   branches, and so does everything downstream, so that is the word here.

   THIS EXISTS BECAUSE THE SCREEN WAS LYING.

   Settings → Locations & tills happily added "Scarborough" and a second
   till, quoted a price for both, and wrote nothing but the browser's own
   state blob back to `PUT /api/tenant/state`. No branch row, no workspace
   row. The ledger posts against `workspaces`, so the new till existed on
   screen and in no place a transaction could be booked — and the new
   location had no staff, no board and no vault, because none of those
   things had anywhere to hang.

   Everything here is idempotent on the identifier it derives, in the same
   way `provisionDesk` is: a retry after a dropped connection finishes the
   job instead of opening a second Scarborough. A location arrives able to
   trade — its own rate board and its first till — because a location that
   cannot take a customer is not one.

   NOTHING HERE CHARGES ANYBODY. There is no billing pipe to charge with
   (see routes/billing.ts and the panel's own "Stripe not connected"), and
   inventing one in the place that creates a branch would be the worst
   possible place to discover that. The response says plainly what the
   commercial effect was, which at present is none, and the change is on
   the audit trail for whoever does the billing by hand.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hasBackendPermission, type BackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { publishStartingBoard } from "../rates/starting-board.js";
import { stripeBillingConfig } from "../billing/stripe.js";
import { audit } from "../audit.js";

const branchBody = z.object({
  name: z.string().trim().min(1, "a location needs a name").max(120),
  /* IANA zone. It decides which day a till session belongs to, so it is
     worth being able to state, and worth defaulting to the desk's existing
     location rather than to a constant. */
  timezone: z.string().trim().max(64).optional(),
  /* The till the location opens with. A location with no till cannot serve
     anybody; naming it lets a client retry the call and get the same one. */
  tillId: z.string().trim().max(32).optional(),
});

const tillBody = z.object({
  /* Optional, and worth sending. With an id the call is idempotent — the
     same id always answers with the same till — and without one the server
     allocates the next free number, so a double-click opens two drawers. */
  tillId: z.string().trim().max(32).optional(),
});

const TILL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/* "Scarborough Village" → "scarborough-village", the same shape
   `provisionDesk` gives a desk's address. Empty when there is nothing
   usable left, and the caller falls back to a number. */
function slugPart(name: string): string {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/* till-01, till-02 … the sequence provisioning already uses. */
const tillNumber = (n: number) => `till-${String(n).padStart(2, "0")}`;

export function registerDeskRoutes(app: FastifyInstance, db: Db) {
  const requirePermission = async (
    req: { cookies: Record<string, string | undefined> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    permission: BackendPermission,
  ): Promise<SessionUser | null> => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    if (!hasBackendPermission(who.role, permission)) {
      reply.code(403).send({
        error: "permission_denied",
        detail:
          permission === "desk:locations"
            ? "Opening a location is the desk owner's decision — an administrator has to do it."
            : `${permission} required`,
      });
      return null;
    }
    return who;
  };

  const branchesOf = (tenantId: string) =>
    db.select().from(schema.branches).where(eq(schema.branches.tenantId, tenantId)).orderBy(asc(schema.branches.createdAt));

  const tillsOf = (tenantId: string) =>
    db.select().from(schema.workspaces).where(eq(schema.workspaces.tenantId, tenantId)).orderBy(asc(schema.workspaces.tillId));

  /* What the desk actually has, from the tables the rest of the system
     reads. The Locations & tills screen should be drawn from this rather
     than from its own saved state, which is how the two came to disagree. */
  app.get("/api/desk/branches", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const branches = await branchesOf(who.tenantId);
    const tills = await tillsOf(who.tenantId);
    return {
      branches: branches.map((b) => ({
        id: b.id,
        name: b.name,
        timezone: b.timezone,
        createdAt: b.createdAt,
        // whether this session may work here at all, so the screen can say so
        authorized: who.authorizedBranchIds.includes(b.id),
        tills: tills
          .filter((w) => w.branchId === b.id)
          .map((w) => ({ workspaceId: w.id, tillId: w.tillId, createdAt: w.createdAt })),
      })),
    };
  });

  app.post("/api/desk/branches", async (req, reply) => {
    const who = await requirePermission(req, reply, "desk:locations");
    if (!who) return;
    const parsed = branchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const { name } = parsed.data;

    const existingBranches = await branchesOf(who.tenantId);
    const already = existingBranches.find((b) => sameName(b.name, name));
    if (already) {
      const tills = (await tillsOf(who.tenantId)).filter((w) => w.branchId === already.id);
      return {
        created: false,
        branch: { id: already.id, name: already.name, timezone: already.timezone },
        tills: tills.map((w) => ({ workspaceId: w.id, tillId: w.tillId })),
        detail: "That location is already open — this is the one you have.",
        billing: await billingEffect(db, who.tenantId, existingBranches.length),
      };
    }

    /* Ids read like the ones provisioning makes: br-<desk>-<location>. The
       desk part comes off the tenant id rather than the site slug, because
       the slug can be changed and an identifier that moves is not one. */
    const base = who.tenantId.replace(/^tnt-/, "");
    const wanted = slugPart(name) || `site-${existingBranches.length + 1}`;
    let branchId = `br-${base}-${wanted}`;
    const taken = new Set(existingBranches.map((b) => b.id));
    for (let n = 2; taken.has(branchId); n++) branchId = `br-${base}-${wanted}-${n}`;

    /* The clock the new location keeps. Copied from the location they
       already run unless they say otherwise — a second shop in the same
       city on a different timezone is a mistake, not a feature. */
    const timezone = parsed.data.timezone || existingBranches[0]?.timezone;
    const tillId = parsed.data.tillId?.trim() || tillNumber(1);
    if (!TILL_ID.test(tillId)) return reply.code(400).send({ error: "invalid_request", detail: "till id: lowercase letters, digits, hyphens" });

    await db.insert(schema.branches).values({
      id: branchId,
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      name,
      ...(timezone ? { timezone } : {}),
    }).onConflictDoNothing();

    const workspaceId = `ws-${branchId.replace(/^br-/, "")}-${tillId}`;
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      tillId,
    }).onConflictDoNothing();
    await copyLedgerRates(db, who.tenantId, who.legalEntityId, branchId, workspaceId);

    /* A location opens able to trade, for the same reason a desk does: a
       branch with no published board shows nothing in the window and fails
       the first quote with "no published branch board". The currencies and
       margin are the desk's own, off the answers it was set up with. */
    const setup = await tenantSetup(db, who.tenantId);
    const board = await publishStartingBoard(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      currencies: Array.isArray(setup.currencies) ? (setup.currencies as string[]) : [],
      homeCurrency: typeof setup.homeCurrency === "string" ? setup.homeCurrency : undefined,
      spreadAll: setup.spreadAll,
      publishedBy: who.staffId,
    });

    /* Whoever opened it can work there. Without this the owner creates a
       location they are then refused at, which is the kind of half-finished
       state this whole file exists to stop. Their home branch is untouched —
       this only widens what they are allowed to reach. */
    const granted = !who.authorizedBranchIds.includes(branchId);
    if (granted) {
      await db
        .update(schema.staffUsers)
        .set({ authorizedBranchIds: [...who.authorizedBranchIds, branchId] })
        .where(eq(schema.staffUsers.id, who.id));
    }

    const billing = await billingEffect(db, who.tenantId, existingBranches.length + 1);
    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      actorId: who.id,
      action: "branch.created",
      /* Somebody gaining access to a location belongs on the trail beside
         the location itself — it is an access change, however reasonable. */
      detail: { name, branchId, workspaceId, tillId, locations: billing.locations, charged: billing.charged, authorized: granted ? who.staffId : null },
    });

    return reply.code(201).send({
      created: true,
      branch: { id: branchId, name, timezone: timezone ?? null },
      tills: [{ workspaceId, tillId }],
      board: { published: board.published, currencies: board.currencies },
      billing,
    });
  });

  app.post<{ Params: { branchId: string } }>("/api/desk/branches/:branchId/tills", async (req, reply) => {
    const who = await requirePermission(req, reply, "desk:tills");
    if (!who) return;
    const parsed = tillBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const branch = (await db
      .select()
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, who.tenantId), eq(schema.branches.id, req.params.branchId)))
      .limit(1))[0];
    if (!branch) return reply.code(404).send({ error: "not_found", detail: "No such location on this desk." });
    /* A manager equips their own counters. The administrator who opened the
       location is authorized on it by the route above. */
    if (!who.authorizedBranchIds.includes(branch.id)) return reply.code(403).send({ error: "branch_denied" });

    const existing = (await tillsOf(who.tenantId)).filter((w) => w.branchId === branch.id);
    let tillId = parsed.data.tillId?.trim() ?? "";
    if (tillId) {
      if (!TILL_ID.test(tillId)) return reply.code(400).send({ error: "invalid_request", detail: "till id: lowercase letters, digits, hyphens" });
      const same = existing.find((w) => w.tillId === tillId);
      if (same) {
        return {
          created: false,
          till: { workspaceId: same.id, tillId: same.tillId, branchId: branch.id },
          detail: "That till is already here — this is the one you have.",
        };
      }
    } else {
      // the next free number, so an unnamed till never collides with one that
      // was deleted and re-made, or with one a second manager just opened
      const used = new Set(existing.map((w) => w.tillId));
      let n = 1;
      while (used.has(tillNumber(n))) n++;
      tillId = tillNumber(n);
    }

    const workspaceId = `ws-${branch.id.replace(/^br-/, "")}-${tillId}`;
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId: branch.id,
      tillId,
    }).onConflictDoNothing();
    await copyLedgerRates(db, who.tenantId, who.legalEntityId, branch.id, workspaceId);

    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId: branch.id,
      actorId: who.id,
      action: "till.created",
      detail: { workspaceId, tillId, branchName: branch.name },
    });

    return reply.code(201).send({
      created: true,
      till: { workspaceId, tillId, branchId: branch.id },
      /* What the client sends as x-workspace-id on every ledger and quote
         call it makes at this till. */
      workspaceId,
    });
  });
}

/* What the desk answered at setup, read defensively — it is a JSON blob
   somebody's browser wrote and this is not the place to discover that. */
async function tenantSetup(db: Db, tenantId: string): Promise<Record<string, unknown>> {
  const rows = await db.select({ setup: schema.tenants.setup }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  const setup = rows[0]?.setup;
  return setup && typeof setup === "object" ? (setup as Record<string, unknown>) : {};
}

/* The commercial truth about what just happened, said out loud.

   The screen offers "Add location · $1,398/mo" and there is no Stripe
   connection behind it, so nothing is charged and the plan does not move.
   Rather than silently doing nothing, every response carries what the
   effect was; the client should show that sentence instead of a price it
   cannot honour. */
async function billingEffect(db: Db, tenantId: string, locations: number) {
  const rows = await db.select({ plan: schema.tenants.plan }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  const connected = !!stripeBillingConfig();
  return {
    locations,
    plan: rows[0]?.plan ?? null,
    charged: false,
    detail: connected
      ? "Locations are not metered. Nothing was charged for this one and the plan is unchanged."
      : "Billing is not connected, so nothing was charged and the plan is unchanged. The change is on the audit trail.",
  };
}

/* Give a new till the rates its branch already trades at.

   `ledger_rates` is scoped to a workspace, not to a branch, so a till
   created without them is one that cannot post: the deal fails with
   RATE_NOT_AVAILABLE and nothing on screen explains why. Copied from the
   till beside it where there is one, and otherwise from any till the desk
   already runs — a new drawer opens on the same prices as the rest of the
   shop, which is the only sane answer.

   Raw SQL because the ledger's tables are not Drizzle models, and wrapped
   because the ledger can live in a different database from this one, in
   which case there is nothing here to copy and the desk's own provisioning
   fills them in. Never let it fail the creation: a till without rates is
   fixable, a half-created till is not. */
async function copyLedgerRates(db: Db, tenantId: string, legalEntityId: string, branchId: string, workspaceId: string) {
  try {
    await db.execute(sql`
      INSERT INTO ledger_rates (tenant_id, legal_entity_id, branch_id, workspace_id, currency, units_per_cad)
      SELECT ${tenantId}, ${legalEntityId}, ${branchId}, ${workspaceId}, currency, units_per_cad
        FROM ledger_rates
       WHERE tenant_id = ${tenantId} AND legal_entity_id = ${legalEntityId}
         AND workspace_id = (
           SELECT workspace_id FROM ledger_rates
            WHERE tenant_id = ${tenantId} AND legal_entity_id = ${legalEntityId}
              AND workspace_id <> ${workspaceId}
            ORDER BY (branch_id = ${branchId}) DESC, workspace_id
            LIMIT 1)
       ON CONFLICT DO NOTHING`);
  } catch (error) {
    console.warn("new till opened without ledger rates:", (error as Error)?.message);
  }
}
