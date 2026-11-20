/* One finish for every desk sign-in.
   Active staff, a shop that is not suspended, a fresh session, the
   same cookie rules, and an audit row. mustChangePassword is left as
   it is, so the password-change gate still applies on the next call.
   An identity-provider sign-in is not treated as a second factor here. */
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { audit } from "../audit.js";
import { createSession } from "./sessions.js";
import { tenantPlan } from "../routes/tenant.js";
import { eq } from "drizzle-orm";
import { SIGN_IN_AUDIT, signInAuditDetail } from "./signin-audit.js";

export type DeskSignInMethod = "password" | "google" | "microsoft";

export type DeskUserPayload = {
  id: string;
  name: string;
  role: string;
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  authorizedBranchIds: string[];
  mustChangePassword: boolean;
  plan: string;
};

export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export async function deskUserPayload(db: Db, user: typeof schema.staffUsers.$inferSelect): Promise<DeskUserPayload> {
  return {
    id: user.staffId,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    authorizedBranchIds: user.authorizedBranchIds,
    mustChangePassword: user.mustChangePassword,
    plan: await tenantPlan(db, user.tenantId),
  };
}

async function tenantSuspended(db: Db, tenantId: string): Promise<boolean> {
  const row = (await db.select({ s: schema.tenants.suspended }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];
  return !!row?.s;
}

export type CompleteSignInResult =
  | { ok: true; token: string; expiresAt: Date; user: DeskUserPayload }
  | { ok: false; error: "inactive" | "suspended"; detail: string };

export async function completeSignIn(
  db: Db,
  user: typeof schema.staffUsers.$inferSelect,
  method: DeskSignInMethod,
  ctx: { ip: string; issuer?: string | null; device?: string | null },
): Promise<CompleteSignInResult> {
  if (!user.active) {
    return { ok: false, error: "inactive", detail: "This account is not active." };
  }
  if (await tenantSuspended(db, user.tenantId)) {
    return { ok: false, error: "suspended", detail: "This desk is suspended. Contact CurrencyDesk." };
  }
  const { token, expiresAt } = await createSession(db, user.id);
  await audit(db, {
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    actorId: user.id,
    action: SIGN_IN_AUDIT.login,
    detail: signInAuditDetail({
      method,
      result: "ok",
      issuer: ctx.issuer ?? undefined,
      device: ctx.device ?? undefined,
      ip: ctx.ip,
      staffId: user.staffId,
      shop: user.tenantId,
    }),
  });
  return { ok: true, token, expiresAt, user: await deskUserPayload(db, user) };
}
