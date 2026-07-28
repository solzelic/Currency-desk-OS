/* ============================================================
   What it takes to open a desk — declared once, in one place.

   Two surfaces run this same list: the operator's own wizard in the OS,
   and the dark control-panel version the platform team uses to set a
   desk up WITH a customer, in their shop or over the phone. They are
   the same steps against the same record, so a desk half-built in the
   shop can be finished by its owner that evening, and neither side has
   to guess where the other got to.

   A step is a thing somebody has to DO, not a screen. That is why the
   list lives here and not in either UI: a screen can be redesigned
   without changing what a desk needs before it can take money.
   ============================================================ */

export type Phase = "business" | "money" | "rules" | "launch";

/* Who is allowed to complete a step.
     either    — the customer, or the platform team on their behalf
     customer  — only the customer. Reserved for things that stop being
                 true if somebody else does them: a password is theirs, and
                 an attestation signed by us is not an attestation. */
export type StepWho = "either" | "customer";

/* How a step is satisfied. The panel and the OS render by this, so a new
   step needs no new UI as long as it is one of these shapes.
     answers  — a small set of values (currencies, thresholds)
     upload   — a document we hold or have sighted
     payment  — money has cleared
     action   — something happened in the product (staff added, float counted) */
export type StepKind = "answers" | "upload" | "payment" | "action";

export interface StepSpec {
  id: string;
  phase: Phase;
  title: string;
  /* What this is for, in the words you would use to the shop owner. Shown
     on both surfaces — the panel is not a different product. */
  blurb: string;
  who: StepWho;
  kind: StepKind;
  /* A desk cannot go live until every required step is done. Optional steps
     are real work that simply does not block trading. */
  requiredToLaunch: boolean;
  /* Steps the signup wizard already answers. These arrive done, so a desk
     that came through the public flow does not ask twice. */
  fromSignup?: boolean;
}

export const STEPS: StepSpec[] = [
  {
    id: "jurisdiction",
    phase: "business",
    title: "Where you operate",
    blurb: "The country you are licensed in, which decides whose rulebook the desk carries.",
    who: "either", kind: "answers", requiredToLaunch: true, fromSignup: true,
  },
  {
    id: "business",
    phase: "business",
    title: "Business details",
    blurb: "Legal name, trading name and the address that goes on every receipt.",
    who: "either", kind: "answers", requiredToLaunch: true, fromSignup: true,
  },
  {
    id: "registration",
    phase: "business",
    title: "Registration number",
    blurb: "Your MSB or equivalent registration. It prints on receipts and reports.",
    who: "either", kind: "answers", requiredToLaunch: true, fromSignup: true,
  },
  {
    id: "owner",
    phase: "money",
    title: "Who owns the desk",
    blurb: "The owner's name and sign-in. They pick their own password — nobody else can.",
    who: "customer", kind: "answers", requiredToLaunch: true, fromSignup: true,
  },
  {
    id: "currencies",
    phase: "money",
    title: "What you trade",
    blurb: "Your home currency and the currencies you buy and sell, so the board opens with the right rows.",
    who: "either", kind: "answers", requiredToLaunch: true,
  },
  {
    id: "float",
    phase: "money",
    title: "Opening float",
    blurb: "What is in the till and the vault on day one. A desk that starts at zero is a desk nobody trusts.",
    who: "either", kind: "action", requiredToLaunch: false,
  },
  {
    id: "thresholds",
    phase: "rules",
    title: "Compliance thresholds",
    blurb: "When ID is required and when a report is triggered. Prefilled from your regulator; change it if your policy is stricter.",
    who: "either", kind: "answers", requiredToLaunch: true, fromSignup: true,
  },
  {
    id: "people",
    phase: "rules",
    title: "Your people",
    blurb: "The tellers who will work the desk, and what each of them is allowed to do.",
    who: "either", kind: "action", requiredToLaunch: false,
  },
  {
    id: "documents",
    phase: "launch",
    title: "Paperwork",
    blurb: "Your registration certificate and owner ID, so we can confirm the desk is who it says it is.",
    who: "either", kind: "upload", requiredToLaunch: true,
  },
  {
    id: "payment",
    phase: "launch",
    title: "Payment",
    blurb: "The last thing before the doors open.",
    who: "either", kind: "payment", requiredToLaunch: true,
  },
];

export const PHASES: { id: Phase; title: string }[] = [
  { id: "business", title: "Business" },
  { id: "money", title: "Money" },
  { id: "rules", title: "Rules" },
  { id: "launch", title: "Launch" },
];

export const STEP_IDS = new Set(STEPS.map((s) => s.id));
export const stepById = (id: string): StepSpec | undefined => STEPS.find((s) => s.id === id);
export const REQUIRED_IDS = STEPS.filter((s) => s.requiredToLaunch).map((s) => s.id);

/* One completed step. `by` is the honest part: a desk set up in the shop by
   the platform team and one the owner did alone are not the same thing, and
   six months later somebody will need to know which this was. */
export interface StepState {
  done: boolean;
  at: string;
  by: "customer" | "operator";
  actorId: string;
  /* What was answered, or what was recorded about a document or payment.
     Deliberately loose — a step's shape belongs to the step. */
  data?: Record<string, unknown>;
  note?: string;
}

export type OnboardingSteps = Record<string, StepState>;

export interface Progress {
  done: number;
  total: number;
  requiredDone: number;
  requiredTotal: number;
  canLaunch: boolean;
  blocking: string[];
}

export function progressOf(steps: OnboardingSteps): Progress {
  const isDone = (id: string) => !!steps[id]?.done;
  const blocking = REQUIRED_IDS.filter((id) => !isDone(id));
  return {
    done: STEPS.filter((s) => isDone(s.id)).length,
    total: STEPS.length,
    requiredDone: REQUIRED_IDS.length - blocking.length,
    requiredTotal: REQUIRED_IDS.length,
    canLaunch: blocking.length === 0,
    blocking,
  };
}
