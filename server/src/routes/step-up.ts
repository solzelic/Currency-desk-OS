/* ============================================================
   A PIN proves one action, once (CD-140, GitHub #630, PR 2).

   POST /api/staff/pin/verify used to answer { ok } and nothing bound
   that answer to anything: the desk decided what the PIN had just
   approved, so the step-up was enforced in the browser only. With an
   action and a target the route mints a token here, bound to that
   action, that target, the shop and the PIN's owner, good for about two
   minutes and usable once. The route that performs the action spends
   it (consumeStepUp), and refuses it when it is for something else,
   somebody else's shop, already spent, past its time, or when the
   person spending it is the token's own owner: the maker is not the
   checker.

   Only the hash is stored. The token itself goes back to the desk once
   and is never written down here.
   ============================================================ */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

/* What a PIN may approve. A new action is added here, named for the
   route that spends it. */
export const STEP_UP_ACTIONS = ["till.handover.approve"] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];
/* Long enough to type a count, short enough that a token left on a
   screen is worth little. */
export const STEP_UP_SECONDS = 120;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function mintStepUp(
  db: Db,
  args: { tenantId: string; staffId: string; issuedBy: string; action: StepUpAction; target: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + STEP_UP_SECONDS * 1000);
  await db.insert(schema.staffStepUpTokens).values({
    id: `sut_${randomUUID()}`,
    tenantId: args.tenantId,
    staffId: args.staffId,
    issuedBy: args.issuedBy,
    action: args.action,
    targetId: args.target,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export type StepUpRefusal = "unknown" | "wrong_tenant" | "wrong_action" | "wrong_target" | "used" | "expired" | "self";

/* Spends a token for one action on one target. `byStaffId` is the
   person performing the action; the token's owner may not be them. A
   refusal spends nothing, so a token sent to the wrong route is still
   good for the right one. The spend itself is one UPDATE guarded on
   used_at, so two routes racing for the same token cannot both win. */
export async function consumeStepUp(
  db: Db,
  args: { token: string; action: string; target: string; tenantId: string; byStaffId: string },
): Promise<{ ok: true; staffId: string } | { ok: false; reason: StepUpRefusal }> {
  if (!/^[0-9a-f]{64}$/.test(args.token)) return { ok: false, reason: "unknown" };
  const [row] = await db
    .select()
    .from(schema.staffStepUpTokens)
    .where(eq(schema.staffStepUpTokens.tokenHash, hashToken(args.token)))
    .limit(1);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.tenantId !== args.tenantId) return { ok: false, reason: "wrong_tenant" };
  if (row.action !== args.action) return { ok: false, reason: "wrong_action" };
  if (row.targetId !== args.target) return { ok: false, reason: "wrong_target" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.staffId === args.byStaffId) return { ok: false, reason: "self" };
  const spent = await db
    .update(schema.staffStepUpTokens)
    .set({ usedAt: new Date(), usedBy: args.byStaffId })
    .where(and(eq(schema.staffStepUpTokens.id, row.id), isNull(schema.staffStepUpTokens.usedAt)))
    .returning();
  if (!spent.length) return { ok: false, reason: "used" };
  return { ok: true, staffId: row.staffId };
}
