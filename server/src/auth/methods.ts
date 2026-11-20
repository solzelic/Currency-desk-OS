/* Which ways a person can still sign in, and whether one of them may be removed.
   The password counts while a hash is stored. Email is not a method and is
   not returned. The last connected method cannot be removed. */
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

export type MethodId = "password" | "google" | "microsoft" | "passkey" | "totp";

export type SignInMethod = {
  id: MethodId;
  name: string;
  connected: boolean;
};

const NAMES: Record<MethodId, string> = {
  password: "Email and password",
  google: "Google",
  microsoft: "Microsoft",
  passkey: "Passkey",
  totp: "Authenticator app",
};

export function removalBlocked(methods: SignInMethod[], id: MethodId): boolean {
  const connected = methods.filter((method) => method.connected);
  if (connected.length > 1) return false;
  return connected.some((method) => method.id === id);
}

export async function listSignInMethods(db: Db, userId: string, passwordHash: string): Promise<SignInMethod[]> {
  const identities = await db.select({ provider: schema.staffIdentities.provider }).from(schema.staffIdentities).where(eq(schema.staffIdentities.staffUserId, userId));
  const passkeys = await db.select({ id: schema.staffPasskeys.id }).from(schema.staffPasskeys).where(and(
    eq(schema.staffPasskeys.staffUserId, userId),
    isNull(schema.staffPasskeys.revokedAt),
  )).limit(1);
  const totp = await db.select({ at: schema.staffTotp.enrolledAt }).from(schema.staffTotp).where(eq(schema.staffTotp.staffUserId, userId)).limit(1);
  const connected = {
    password: passwordHash.length > 0,
    google: identities.some((row) => row.provider === "google"),
    microsoft: identities.some((row) => row.provider === "microsoft"),
    passkey: passkeys.length > 0,
    totp: !!totp[0]?.at,
  };
  return (Object.keys(NAMES) as MethodId[]).map((id) => ({
    id,
    name: NAMES[id],
    connected: connected[id],
  }));
}

/** An owner can use an identity provider only after a passkey or an
    authenticator exists, and at least one unused recovery code exists. */
export async function ownerSecondStepReady(db: Db, user: { id: string; role: string }): Promise<boolean> {
  if (user.role !== "administrator") return true;
  const methods = await listSignInMethods(db, user.id, "");
  const factor = methods.some((method) => (method.id === "passkey" || method.id === "totp") && method.connected);
  if (!factor) return false;
  const codes = await db.select({ id: schema.staffRecoveryCodes.id }).from(schema.staffRecoveryCodes).where(and(
    eq(schema.staffRecoveryCodes.staffUserId, user.id),
    isNull(schema.staffRecoveryCodes.usedAt),
  )).limit(1);
  return codes.length > 0;
}
