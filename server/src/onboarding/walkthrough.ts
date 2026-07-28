/* ============================================================
   The walkthrough — one application that is always there.

   Onboarding is a thing you do to somebody, so it is hard to rehearse:
   the only way to practise was to invent a customer, and then live with
   the junk they left behind. This is a permanent application with a real
   reference you can open any time, run start to finish, and reset.

     CD-WALKTHRU  →  a properly-formed CurrencyDesk reference, made from
                     the same alphabet as every other one (no 0/O/1/I, so
                     it cannot be misread down a phone line). It goes
                     through exactly the code paths a real one does — a
                     rehearsal against a special case only rehearses the
                     special case.

   It is kept out of every count. The site's "N of 100 desks claimed" and
   the panel's funnel must not move because somebody practised, or the
   number stops meaning what it says on the page.
   ============================================================ */
import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";

export const WALKTHROUGH_REF = "CD-WALKTHRU";
const WALKTHROUGH_ID = "enq-walkthrough";

/* Deliberately half-answered, and deliberately plausible. The point is to
   see what a real application looks like when it lands: some of it already
   known, the rest still to ask. An example with everything filled in would
   rehearse nothing. */
const DETAILS = {
  workspace: "harbourfx.currencydeskos.com",
  website: "harbourfx.ca",
  jurisdiction: "CA",
  role: "Owner / Founder",
  employees: "2–5",
  monthlyVolume: "$500K – $2M",
  branches: "single",
  runningOn: "Spreadsheets",
  timeline: "As soon as possible",
};

export async function seedWalkthrough(db: Db): Promise<void> {
  await db
    .insert(schema.enquiries)
    .values({
      id: WALKTHROUGH_ID,
      reference: WALKTHROUGH_REF,
      kind: "early_access",
      email: "walkthrough@currencydeskos.com",
      name: "Sam Rivera",
      details: DETAILS,
      // already invited, because the interesting part is what happens after
      status: "invited",
      // no charter number: a rehearsal must not take a founding place
      charterNo: null,
      isDemo: true,
    })
    .onConflictDoNothing();
  // keep it usable if an older row predates the flag or drifted
  await db
    .update(schema.enquiries)
    .set({ isDemo: true, charterNo: null, kind: "early_access", details: DETAILS })
    .where(eq(schema.enquiries.id, WALKTHROUGH_ID));
}

/* Put it back to how it arrives, so the next run starts from the same
   place. Wipes the answers, not the application. */
export async function resetWalkthrough(db: Db): Promise<void> {
  await db.delete(schema.onboarding).where(eq(schema.onboarding.enquiryId, WALKTHROUGH_ID));
  await db
    .update(schema.enquiries)
    .set({ status: "invited", tenantId: null, decidedAt: null, decidedBy: null, notes: null })
    .where(eq(schema.enquiries.id, WALKTHROUGH_ID));
}

export const isWalkthrough = (row: { id?: string; isDemo?: boolean } | undefined): boolean =>
  !!row && (row.isDemo === true || row.id === WALKTHROUGH_ID);
