/* ============================================================
   The confirmation code, and where it lives.

   WHY THIS IS ITS OWN FILE

   Two surfaces need to mint one of these and they are nothing like each
   other. The customer's own setup screen asks for a code and types it
   back; the platform panel asks for one on their behalf, because the
   founder is on the phone with them and the customer never got the email.

   Both have to be the SAME code, stored the same way, expiring on the
   same clock. When this logic lived inside the public routes as a
   closure, the only way for the panel to reach it was to grow a second
   copy — and a second copy of "what counts as a valid code" is how you
   end up with one that works on one screen and not the other.

   The code itself is never stored. Only its hash, an attempt count, and
   when it dies.
   ============================================================ */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { hashCode } from "../email.js";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

/* Where the confirmation state lives on the onboarding row. Under a
   double-underscore key because `answers` is otherwise exactly the design's
   field list, and anything in here is ours rather than theirs. */
export interface VerifyState {
  codeHash?: string;
  attempts?: number;
  expiresAt?: number;
  confirmedAt?: number;
  channel?: string;
  sentTo?: string;
}

export async function loadOrCreateOnboarding(db: Db, enquiryId: string) {
  const rows = await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, enquiryId)).limit(1);
  if (rows[0]) return rows[0];
  await db.insert(schema.onboarding).values({ enquiryId }).onConflictDoNothing();
  return (await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, enquiryId)).limit(1))[0]!;
}

export const verifyStateOf = (row: { answers?: Record<string, unknown> | null }): VerifyState =>
  (((row.answers ?? {}) as Record<string, unknown>).__verify ?? {}) as VerifyState;

export async function setVerifyState(db: Db, enquiryId: string, patch: VerifyState): Promise<void> {
  const row = await loadOrCreateOnboarding(db, enquiryId);
  const answers = { ...((row.answers ?? {}) as Record<string, unknown>) };
  answers.__verify = { ...verifyStateOf(row), ...patch };
  await db.update(schema.onboarding).set({ answers, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, enquiryId));
}

/* A code is one code. Issuing a new one resets the attempt count and
   invalidates the last, so "send it again" is always the right advice. */
export const issueCode = (db: Db, enquiryId: string, code: string, sentTo: string, channel: string) =>
  setVerifyState(db, enquiryId, {
    codeHash: hashCode(code),
    attempts: 0,
    expiresAt: Date.now() + CODE_TTL_MS,
    confirmedAt: undefined,
    channel,
    sentTo,
  });
