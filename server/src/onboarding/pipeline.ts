/* ============================================================
   The early-access pipeline — one place that owns moving an
   application from one stage to the next.

   WHY THIS IS A FUNCTION AND NOT A HANDLER

   The invite email used to be sent from inside the route that changed
   the status. That works exactly once: the day something other than a
   person clicking a button needs to move an application — a reviewer
   agent, a nightly sweep, a rule that chases anybody sitting in
   `reviewing` for a week — the sending has to be lifted out and
   rewritten, and until then there is no single place that can answer
   "what happens when somebody is accepted?"

   So a transition is the unit. Every mover calls the same function,
   every move is recorded the same way, and what gets sent is declared
   next to the stage rather than buried in whoever happened to trigger
   it. Automating a stage later means calling this with a different
   `by`, and nothing else changes.

   WHAT A STAGE IS, AND WHAT IT IS NOT

   `status` is where an application IS: one value, ordered, and the
   thing automation keys off. Labels are what an application is LIKE:
   many, unordered, and they drive nothing. Keeping them apart is what
   stops you inventing a stage called "high-volume-reviewing" and then
   being unable to automate either half of it.
   ============================================================ */
import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { audit } from "../audit.js";
import { inviteEmail, reviewEmail, sendEmail, type EmailStatus } from "../email.js";

export type Stage = "new" | "reviewing" | "invited" | "accepted" | "declined";

/* The board, in the order an application travels. `declined` is not a
   column anybody works towards, so it sits apart. */
export const STAGES: { id: Stage; title: string; blurb: string; terminal?: boolean }[] = [
  { id: "new", title: "Applied", blurb: "Came in from the site. Nobody has looked yet." },
  { id: "reviewing", title: "Reviewing", blurb: "We are looking at them. They have been told." },
  { id: "invited", title: "Invited", blurb: "They hold a working code and can set their desk up." },
  { id: "accepted", title: "Open", blurb: "They finished, and the desk exists.", terminal: true },
  { id: "declined", title: "Declined", blurb: "Not for now. Their code no longer opens anything.", terminal: true },
];

/* `accepted` is deliberately absent from every list. A desk existing is
   something the applicant does by finishing their setup — it is a fact,
   not a decision, and an operator marking it by hand would be putting a
   lie in the funnel. */
const ALLOWED: Record<Stage, Stage[]> = {
  new: ["reviewing", "invited", "declined"],
  reviewing: ["invited", "declined", "new"],
  invited: ["reviewing", "declined"],   // moving out of `invited` is what revokes the code
  accepted: [],
  declined: ["reviewing", "new"],
};

export const canMove = (from: Stage, to: Stage): boolean => (ALLOWED[from] ?? []).includes(to);

/* What each stage sends on arrival. Declared here, beside the stage, so
   "what does the applicant hear when we accept them?" is answerable by
   reading one file rather than by grepping for sendEmail. */
type Mail = { subject: string; text: string; html: string };
const ON_ARRIVAL: Partial<Record<Stage, (a: Row, origin: string) => Mail>> = {
  reviewing: (a) => reviewEmail({ name: a.name }),
  invited: (a, origin) => inviteEmail({ name: a.name, reference: a.reference, origin }),
};

type Row = typeof schema.enquiries.$inferSelect;

export interface Moved {
  ok: true;
  from: Stage;
  to: Stage;
  /* Whether anything went out, and how it went. Null when the stage sends
     nothing — which is different from a send that failed, and the panel
     needs to be able to tell those apart. */
  email: EmailStatus | null;
}
export interface Refused { ok: false; error: string; detail: string }

export async function moveTo(
  db: Db,
  row: Row,
  to: Stage,
  by: string,
  opts: { origin?: string; actorId?: string | null; resend?: boolean } = {},
): Promise<Moved | Refused> {
  const from = (row.status ?? "new") as Stage;

  if (from === to && !opts.resend) {
    return { ok: false, error: "no_change", detail: `Already ${to}.` };
  }
  if (from === "accepted") {
    return { ok: false, error: "already_open", detail: "Their desk is open. That is not a stage you can move them out of." };
  }
  if (to === "accepted") {
    return { ok: false, error: "not_settable", detail: "An application becomes accepted when the desk is created, not by hand." };
  }
  if (from !== to && !canMove(from, to)) {
    return { ok: false, error: "bad_move", detail: `Cannot go from ${from} to ${to}.` };
  }

  const set: Partial<Row> = { status: to };
  /* When a decision was taken, and by whom. `new` is the absence of a
     decision, so moving back there clears it rather than recording that
     somebody decided to be undecided. */
  if (to === "new") {
    set.decidedAt = null;
    set.decidedBy = null;
  } else {
    set.decidedAt = new Date();
    set.decidedBy = by;
  }
  if (to !== "new" && !row.handledAt) set.handledAt = new Date();
  await db.update(schema.enquiries).set(set).where(eq(schema.enquiries.id, row.id));

  /* Best effort, always. The stage is already saved — a mail outage must
     not silently roll back a decision, and the operator can see it failed
     and send again. */
  let email: EmailStatus | null = null;
  const compose = ON_ARRIVAL[to];
  if (compose && !row.isDemo) {
    const origin = (opts.origin ?? process.env.PUBLIC_ORIGIN ?? "https://www.currencydeskos.com").replace(/\/+$/, "");
    const mail = compose(row, origin);
    email = await sendEmail(row.email, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
  }

  await audit(db, {
    tenantId: row.tenantId ?? "tnt-platform",
    legalEntityId: "-", branchId: "-",
    actorId: opts.actorId ?? null,
    /* Keep the established name. Audit rows already carry it and it is a
       six-year compliance trail — renaming an action orphans every record
       written before the rename and every query anybody has on it. */
    action: "admin.enquiry_status",
    detail: { reference: row.reference, from, to, by, ...(email ? { email } : {}) },
  });

  return { ok: true, from, to, email };
}

/* Labels. Deliberately free-form: the moment you make an operator pick
   from a list you have to guess the list, and they will want one you did
   not think of on their second day. Normalised only so that "High Volume"
   and "high volume" are the same label rather than two. */
export const cleanLabel = (s: string): string =>
  s.trim().replace(/\s+/g, " ").slice(0, 32).toLowerCase();

export function labelsOf(row: { labels?: unknown }): string[] {
  return Array.isArray(row.labels) ? (row.labels as unknown[]).map(String) : [];
}
