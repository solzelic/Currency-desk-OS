/* ============================================================
   Sign-up v2.1, A. Passkey (SIGNUP-LOGIC §3.1 A).

   Registration only; signing in with it is the Sign-in pack. Options:
   ES256 + RS256, a discoverable credential, user verification required,
   no authenticator attachment (a phone by QR or a security key also
   works), attestation none, a fresh one-use challenge for five minutes.
   The user fields go to the device, never to the screen.

   Verification checks the challenge, the origin, the RP ID and the UV
   flag (@simplewebauthn/server, pinned: hand-parsing CBOR and COSE keys is
   exactly the code that should come from a maintained, audited library).

   The RP ID and origins come from the environment, because the pack's
   "currencydesk.app" is not the domain the site is served from
   (www.currencydeskos.com) and a passkey is bound to its RP ID for life.
   CTO to confirm the production value before release.
   ============================================================ */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { schema, type Db } from "../db/index.js";
import { CHALLENGE_TTL_MS, relyingParty, type RelyingParty } from "../auth/webauthn.js";

export { CHALLENGE_TTL_MS, relyingParty };
export type { RelyingParty };

export async function passkeyOptions(
  db: Db,
  rp: RelyingParty,
  o: { enquiryId: string; accountId: string; cdId: string; operatingName: string; attemptHash: string },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpID: rp.id,
    rpName: rp.name,
    userID: new TextEncoder().encode(o.accountId),
    /* NOT the email. These options are JSON the page can read, and the page
       may have been opened by somebody who only knows the ID (§2.1: nothing
       personal before the email code). The pack's owner_email/owner_name
       here would leak both. The ID is what they sign in with, so it is the
       honest username in a passkey manager. Raised with CTO and Sol. */
    userName: o.cdId,
    userDisplayName: o.operatingName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
    timeout: CHALLENGE_TTL_MS,
  });
  await db.insert(schema.signupChallenges).values({
    id: `chl-${randomUUID()}`, enquiryId: o.enquiryId, purpose: "passkey", challenge: options.challenge,
    attemptHash: o.attemptHash, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return options;
}

export type PasskeyResult =
  | { ok: true; passkey: { id: string; publicKey: string; signCount: number; transports: string[]; aaguid: string; backupEligible: boolean; backupState: boolean } }
  | { ok: false; reason: "no_challenge" | "not_verified" };

/* The challenge is spent whatever the outcome, so a response cannot be tried
   twice against it. */
export async function verifyPasskey(
  db: Db,
  rp: RelyingParty,
  o: { enquiryId: string; attemptHash: string; response: RegistrationResponseJSON },
): Promise<PasskeyResult> {
  const challenge = (await db.select().from(schema.signupChallenges).where(and(
    eq(schema.signupChallenges.enquiryId, o.enquiryId),
    eq(schema.signupChallenges.purpose, "passkey"),
    eq(schema.signupChallenges.attemptHash, o.attemptHash),
    isNull(schema.signupChallenges.usedAt),
    gt(schema.signupChallenges.expiresAt, new Date()),
  )).orderBy(desc(schema.signupChallenges.createdAt)).limit(1))[0];
  if (!challenge) return { ok: false, reason: "no_challenge" };
  const spent = await db.update(schema.signupChallenges).set({ usedAt: new Date() })
    .where(and(eq(schema.signupChallenges.id, challenge.id), isNull(schema.signupChallenges.usedAt)))
    .returning();
  if (!spent.length) return { ok: false, reason: "no_challenge" };

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: o.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch (err) {
    console.warn(`[signup passkey] refused: ${err instanceof Error ? err.name : "error"}`);
    return { ok: false, reason: "not_verified" };
  }
  const info = verification.registrationInfo;
  if (!verification.verified || !info) return { ok: false, reason: "not_verified" };
  return {
    ok: true,
    passkey: {
      id: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
      signCount: info.credential.counter,
      transports: info.credential.transports ?? [],
      aaguid: info.aaguid,
      backupEligible: info.credentialDeviceType === "multiDevice",
      backupState: info.credentialBackedUp,
    },
  };
}
