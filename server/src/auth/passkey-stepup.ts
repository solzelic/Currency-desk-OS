/* Step-up with a passkey that is already registered to this staff row.
   This is not passkey sign-in. The person is already signed in. UV is
   required, and the sign counter must move forward. */
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { schema, type Db } from "../db/index.js";
import { relyingParty, CHALLENGE_TTL_MS, type RelyingParty } from "./webauthn.js";

export async function passkeyStepUpOptions(db: Db, userId: string, tenantId: string, rp: RelyingParty, sessionHash: string) {
  const keys = await db.select().from(schema.staffPasskeys).where(and(
    eq(schema.staffPasskeys.tenantId, tenantId),
    eq(schema.staffPasskeys.staffUserId, userId),
    isNull(schema.staffPasskeys.revokedAt),
  ));
  if (!keys.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: "required",
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: keys.map((key) => ({
      id: key.credentialId,
      transports: (key.transports ?? []) as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[],
    })),
  });
  await db.insert(schema.authChallenges).values({
    id: `chl-${randomUUID()}`,
    tenantId,
    purpose: "passkey_auth",
    challengeHash: options.challenge,
    staffUserId: userId,
    sessionHash,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return options;
}

export async function passkeyStepUpVerify(
  db: Db,
  userId: string,
  tenantId: string,
  rp: RelyingParty,
  sessionHash: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const challenge = (await db.select().from(schema.authChallenges).where(and(
    eq(schema.authChallenges.tenantId, tenantId),
    eq(schema.authChallenges.purpose, "passkey_auth"),
    eq(schema.authChallenges.staffUserId, userId),
    eq(schema.authChallenges.sessionHash, sessionHash),
    isNull(schema.authChallenges.usedAt),
    gt(schema.authChallenges.expiresAt, new Date()),
  )).limit(1))[0];
  if (!challenge) return false;
  const spent = await db.update(schema.authChallenges).set({ usedAt: new Date() }).where(and(
    eq(schema.authChallenges.id, challenge.id),
    eq(schema.authChallenges.tenantId, tenantId),
    isNull(schema.authChallenges.usedAt),
  )).returning();
  if (!spent.length) return false;
  const key = (await db.select().from(schema.staffPasskeys).where(and(
    eq(schema.staffPasskeys.tenantId, tenantId),
    eq(schema.staffPasskeys.staffUserId, userId),
    eq(schema.staffPasskeys.credentialId, response.id),
    isNull(schema.staffPasskeys.revokedAt),
  )).limit(1))[0];
  if (!key) return false;
  try {
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challengeHash,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: {
        id: key.credentialId,
        publicKey: Buffer.from(key.publicKey, "base64url"),
        counter: key.signCount,
        transports: key.transports ?? [],
      },
    });
    if (!verified.verified || !verified.authenticationInfo.userVerified) return false;
    if (verified.authenticationInfo.newCounter < key.signCount) return false;
    if (key.signCount > 0 && verified.authenticationInfo.newCounter <= key.signCount) return false;
    await db.update(schema.staffPasskeys).set({
      signCount: verified.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    }).where(eq(schema.staffPasskeys.id, key.id));
    return true;
  } catch {
    return false;
  }
}

export { relyingParty };
