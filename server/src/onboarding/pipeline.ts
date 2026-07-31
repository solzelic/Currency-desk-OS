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

export type Stage = "new" | "reviewing" | "hold" | "invited" | "accepted" | "declined";

/* The board, in the order an application travels.

   An application does not sit anywhere waiting to be noticed. It arrives
   IN REVIEW and is acknowledged in the same breath, because the gap
   between "we got it" and any human looking is where an applicant decides
   nobody is home.

   `new` is left in the type for rows that predate that, and only shows as
   a column while any of them exist. Nothing lands there any more. */
/* THE ORDER IS THE JOURNEY, AND THE JOURNEY IS NOT A STRAIGHT LINE.

   Three stages are the path a customer actually walks: somebody looks at
   them, we approve them, they open a desk. They are numbered, because
   that is a thing you can count and a thing you can explain to a new
   starter in one breath: one, two, three.

   The other two are ways OUT of that path, not steps along it. Held and
   declined are where an application stops, and drawing them in the
   middle of the run — which is what happened when the list was simply
   the order the stages were invented in — made the eye read them as
   somewhere you pass through. They come after, marked as exits. */
export const STAGES: {
  id: Stage; title: string; blurb: string;
  /* What pressing the button DOES, in the imperative. "Approve" reads as a
     decision; "→ Invited" reads as a database field, and an operator
     working a queue should not have to translate. */
  action: string;
  /* 1, 2, 3 along the main path; absent on the ways out of it. */
  step?: number;
  /* A place an application stops rather than passes through. */
  exit?: boolean;
  terminal?: boolean; legacy?: boolean; primary?: boolean;
}[] = [
  /* No `action`, because nothing moves INTO these two. `new` is only where
     rows that predate automatic acknowledgement are sitting, and a desk
     opening is something the applicant does. */
  { id: "new", title: "Not yet acknowledged", action: "", legacy: true,
    blurb: "Came in before applications were acknowledged automatically. Nothing new lands here." },
  { id: "reviewing", title: "In review", action: "Move to review", step: 1,
    blurb: "Where every application starts. They have been told we are looking." },
  { id: "invited", title: "Invited", action: "Approve & invite", primary: true, step: 2,
    blurb: "Approved. They have their ID and the link, and can set their desk up." },
  { id: "accepted", title: "Open", action: "", terminal: true, step: 3,
    blurb: "They finished. The desk exists and they are trading." },
  { id: "hold", title: "On hold", action: "Hold for later", exit: true,
    blurb: "Worth keeping, not now. They hear nothing — this is our note, not a decision they were told about." },
  { id: "declined", title: "Declined", action: "Decline", terminal: true, exit: true,
    blurb: "Not for us. Their code no longer opens anything." },
];

/* `accepted` is deliberately absent from every list. A desk existing is
   something the applicant does by finishing their setup — it is a fact,
   not a decision, and an operator marking it by hand would be putting a
   lie in the funnel. */
const ALLOWED: Record<Stage, Stage[]> = {
  new: ["reviewing", "invited", "hold", "declined"],
  reviewing: ["invited", "hold", "declined"],
  hold: ["reviewing", "invited", "declined"],
  invited: ["reviewing", "hold", "declined"],   // moving out of `invited` is what revokes the code
  accepted: [],
  declined: ["reviewing", "hold"],
};

export const canMove = (from: Stage, to: Stage): boolean => (ALLOWED[from] ?? []).includes(to);

/* Where an application can go from where it is. Served to the panel so the
   buttons on a card ARE the legal moves rather than a second guess at them —
   an operator should never be offered a button that returns 400. */
export const movesFrom = (from: Stage): Stage[] => ALLOWED[from] ?? [];

/* The board, with each column carrying the moves that leave it. One shape
   for both the list and a single application's page. */
export const board = () => STAGES.map((s) => ({ ...s, next: movesFrom(s.id) }));

/* What the emails call their shop, and where.

   The designed emails open with "thanks for putting <their shop>
   forward" and print the name across the charter card, so a blank there
   is not a missing nicety — it is the most personal line in the email
   reading like a mail merge that failed.

   The form asks for the shop's name now. Every application lodged before
   it did has nothing to put there, so the workspace they chose stands in:
   `yorkville-currency` was typed by somebody thinking of their shop, and
   tidied up it is usually the shop. Where even that is absent the
   templates drop the phrase rather than printing an empty gap. */
const PLACES: Record<string, string> = {
  CA: "Canada", US: "United States", GB: "United Kingdom", AE: "United Arab Emirates",
  AU: "Australia", NZ: "New Zealand", SG: "Singapore", IE: "Ireland", IN: "India",
};
function aboutTheShop(a: Row): { shopName: string | null; place: string | null } {
  const d = (a.details ?? {}) as Record<string, unknown>;
  /* Two names for one thing, because two doors write it: the public form
     asks for `shopName`, and the panel's "add a desk" has always called it
     `businessName`. Read both rather than making one of them wrong. */
  const given = String(d.shopName ?? d.businessName ?? "").trim();
  const slug = String(d.workspace ?? "").trim().split(".")[0] ?? "";
  const fromSlug = slug
    ? slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim()
    : "";
  const jur = String(d.jurisdiction ?? "").trim().toUpperCase();
  return {
    shopName: given || fromSlug || null,
    place: String(d.city ?? "").trim() || PLACES[jur] || (jur || null),
  };
}

/* What each stage sends on arrival. Declared here, beside the stage, so
   "what does the applicant hear when we accept them?" is answerable by
   reading one file rather than by grepping for sendEmail. */
type Mail = { subject: string; text: string; html: string };
const ON_ARRIVAL: Partial<Record<Stage, (a: Row, origin: string) => Mail>> = {
  reviewing: (a) => reviewEmail({ name: a.name, reference: a.reference, ...aboutTheShop(a) }),
  invited: (a, origin) => inviteEmail({
    name: a.name, reference: a.reference, origin, cohortNo: a.charterNo, ...aboutTheShop(a),
  }),
  /* `hold` and `declined` send nothing on purpose. Holding somebody is a
     note to ourselves; telling them they are parked is worse than saying
     nothing. Declining deserves a human reply, not an automated one. */
};

/* Which stages speak to the applicant. Exported so the communications
   catalogue can be checked against it rather than kept in step by hand: a
   stage that starts or stops sending should break that check, not surprise
   somebody who thought they knew what a button did. */
export const mailStages = (): Stage[] => Object.keys(ON_ARRIVAL) as Stage[];

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
