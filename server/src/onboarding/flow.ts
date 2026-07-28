/* ============================================================
   Opening a desk — the questions, once.

   This is the signup flow itself, declared as data: steps made of
   FIELDS, not a checklist of things somebody ticks. That matters,
   because the same declaration drives three things that must never
   drift apart —

     · the owner's wizard, when they set the desk up themselves
     · the platform team's version in the control panel, when we do it
       with them at their counter or over the phone
     · what actually gets built when the desk is created

   And because a step is a set of answers rather than a box, an answer
   we ALREADY HAVE can arrive filled in. Somebody who applied for early
   access has already told us their name, their email, the address they
   picked and the country they trade in. Asking again is the flow
   admitting it was not listening.
   ============================================================ */

export type FieldType = "text" | "email" | "tel" | "select" | "number" | "money" | "currencies" | "password";

export interface Field {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /* Filled in from something we already know rather than asked. The UI
     shows these as answered-but-editable: prefilled is a courtesy, not a
     decision taken away from them. */
  prefillFrom?: string;
  /* Worked out from another answer — the regulator follows the country,
     the reporting threshold follows the regulator. Shown, never asked. */
  derived?: boolean;
}

export type StepKind = "form" | "documents" | "payment";
/* Who may answer. `customer` is for things that stop being true if we do
   them: a password we chose is not their password. */
export type StepWho = "either" | "customer";

export interface Step {
  id: string;
  phase: string;
  title: string;
  blurb: string;
  kind: StepKind;
  who: StepWho;
  fields: Field[];
}

export const PHASES = [
  { id: "business", title: "Business" },
  { id: "owner", title: "Owner" },
  { id: "money", title: "Money" },
  { id: "rules", title: "Rules" },
  { id: "launch", title: "Launch" },
];

const COUNTRIES = [
  { value: "CA", label: "Canada" },
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "AU", label: "Australia" },
];

/* What follows from where they trade. The desk carries its regulator's
   rulebook, so this is not a preference — it is a consequence, and the flow
   should state it rather than make somebody look it up. */
export const JURISDICTION: Record<string, { regulator: string; currency: string; idThreshold: number; reportThreshold: number }> = {
  CA: { regulator: "FINTRAC", currency: "CAD", idThreshold: 3000, reportThreshold: 10000 },
  US: { regulator: "FinCEN", currency: "USD", idThreshold: 3000, reportThreshold: 10000 },
  GB: { regulator: "HMRC", currency: "GBP", idThreshold: 1000, reportThreshold: 10000 },
  AU: { regulator: "AUSTRAC", currency: "AUD", idThreshold: 1000, reportThreshold: 10000 },
};

export const STEPS: Step[] = [
  {
    id: "business",
    phase: "business",
    title: "The business",
    blurb: "What goes on the receipts, the reports and the front of the desk.",
    kind: "form", who: "either",
    fields: [
      { id: "businessName", label: "Trading name", type: "text", required: true, placeholder: "York FX", help: "What customers call you." },
      { id: "legalName", label: "Legal name", type: "text", help: "If it differs from the trading name." },
      { id: "country", label: "Country", type: "select", required: true, options: COUNTRIES, prefillFrom: "application.jurisdiction" },
      { id: "regulator", label: "Regulator", type: "text", derived: true, help: "Follows from the country — this is the rulebook the desk carries." },
    ],
  },
  {
    id: "registration",
    phase: "business",
    title: "Registration",
    blurb: "Your money-services registration. It prints on receipts and every report you file.",
    kind: "form", who: "either",
    fields: [
      { id: "msbNumber", label: "Registration number", type: "text", required: true, placeholder: "M20-1234567" },
      { id: "address", label: "Street address", type: "text", required: true },
      { id: "city", label: "City", type: "text", required: true },
      { id: "region", label: "Province / State", type: "text" },
      { id: "postal", label: "Postcode", type: "text" },
      { id: "phone", label: "Shop phone", type: "tel" },
    ],
  },
  {
    id: "owner",
    phase: "owner",
    title: "Who owns it",
    blurb: "The account that runs the desk. Their password is theirs — we never set it.",
    kind: "form", who: "either",
    fields: [
      { id: "ownerName", label: "Owner's name", type: "text", required: true, prefillFrom: "application.name" },
      { id: "email", label: "Email", type: "email", required: true, prefillFrom: "application.email", help: "This is their sign-in." },
      { id: "slug", label: "Desk address", type: "text", required: true, prefillFrom: "application.workspace", help: "yourshop.currencydeskos.com" },
    ],
  },
  {
    id: "password",
    phase: "owner",
    title: "Their password",
    blurb: "Set by the owner, on their own screen. Nobody else can do this one — including us.",
    kind: "form", who: "customer",
    fields: [
      { id: "password", label: "Password", type: "password", required: true, help: "At least 8 characters." },
    ],
  },
  {
    id: "trading",
    phase: "money",
    title: "What you trade",
    blurb: "Your home currency and the currencies you deal in, so the board opens with the right rows.",
    kind: "form", who: "either",
    fields: [
      { id: "homeCurrency", label: "Home currency", type: "text", derived: true, help: "Follows from the country." },
      { id: "currencies", label: "Currencies you trade", type: "currencies", required: true, placeholder: "USD, EUR, GBP" },
    ],
  },
  {
    id: "plan",
    phase: "money",
    title: "Plan",
    blurb: "What they are signing up for. This is what Stripe charges.",
    kind: "form", who: "either",
    fields: [
      {
        id: "plan", label: "Plan", type: "select", required: true,
        options: [
          { value: "basic", label: "Basic" },
          { value: "pro", label: "Pro" },
          { value: "premium", label: "Premium" },
        ],
      },
    ],
  },
  {
    id: "compliance",
    phase: "rules",
    title: "Compliance thresholds",
    blurb: "When ID is taken and when a report is triggered. Prefilled from the regulator — raise them if your own policy is stricter.",
    kind: "form", who: "either",
    fields: [
      { id: "idThreshold", label: "Take ID over", type: "money", required: true, derived: true },
      { id: "reportThreshold", label: "Report over", type: "money", required: true, derived: true },
    ],
  },
  {
    id: "documents",
    phase: "launch",
    title: "Paperwork",
    blurb: "Registration certificate and owner ID, so the desk is who it says it is.",
    kind: "documents", who: "either",
    fields: [],
  },
  {
    id: "payment",
    phase: "launch",
    title: "Payment",
    blurb: "The last thing before the doors open.",
    kind: "payment", who: "either",
    fields: [],
  },
];

export const stepById = (id: string): Step | undefined => STEPS.find((s) => s.id === id);
export const ALL_FIELDS: Field[] = STEPS.flatMap((s) => s.fields);
export const fieldById = (id: string): Field | undefined => ALL_FIELDS.find((f) => f.id === id);

export type Answers = Record<string, unknown>;
export type Source = "entered" | "application" | "derived";

/* Everything the early-access application already told us, in the shape the
   flow asks for. This is the whole point of the redesign: an applicant has
   answered half of this once already. */
export function fromApplication(app: { name?: string | null; email?: string | null; details?: Record<string, unknown> | null } | null): Answers {
  if (!app) return {};
  const d = (app.details ?? {}) as Record<string, unknown>;
  const out: Answers = {};
  if (app.name) out.ownerName = app.name;
  if (app.email) out.email = app.email;
  // "newshop.currencydeskos.com" → "newshop"
  if (typeof d.workspace === "string" && d.workspace) out.slug = d.workspace.split(".")[0]!.toLowerCase();
  if (typeof d.jurisdiction === "string" && JURISDICTION[d.jurisdiction]) out.country = d.jurisdiction;
  return out;
}

/* What follows from what has been answered. Kept separate from the answers
   themselves so that changing the country moves the regulator with it,
   instead of leaving a stale value somebody has to notice. */
export function derive(a: Answers): Answers {
  const j = JURISDICTION[String(a.country ?? "")] ?? null;
  if (!j) return {};
  return {
    regulator: j.regulator,
    homeCurrency: j.currency,
    idThreshold: j.idThreshold,
    reportThreshold: j.reportThreshold,
  };
}

/* One value, and where it came from — so a screen can say "we already knew
   this" rather than presenting our guess as their answer. */
export interface Resolved { value: unknown; source: Source | null }

export function resolve(entered: Answers, application: Answers): Record<string, Resolved> {
  const merged: Answers = { ...application, ...entered };
  const derived = derive(merged);
  const out: Record<string, Resolved> = {};
  for (const f of ALL_FIELDS) {
    if (f.id in entered && entered[f.id] !== undefined && entered[f.id] !== "") {
      out[f.id] = { value: entered[f.id], source: "entered" };
    } else if (f.derived && f.id in derived) {
      out[f.id] = { value: derived[f.id], source: "derived" };
    } else if (f.id in application && application[f.id] !== undefined && application[f.id] !== "") {
      out[f.id] = { value: application[f.id], source: "application" };
    } else {
      out[f.id] = { value: null, source: null };
    }
  }
  return out;
}

export interface StepProgress { id: string; done: boolean; missing: string[] }

export function stepProgress(resolved: Record<string, Resolved>, marks: Record<string, boolean>): StepProgress[] {
  return STEPS.map((s) => {
    // steps with no fields (paperwork, payment) are done when marked
    if (!s.fields.length) return { id: s.id, done: !!marks[s.id], missing: [] };
    const missing = s.fields.filter((f) => f.required && (resolved[f.id]?.value ?? null) === null).map((f) => f.id);
    return { id: s.id, done: missing.length === 0, missing };
  });
}

export function canCreateDesk(resolved: Record<string, Resolved>): { ok: boolean; missing: string[] } {
  // what /api/signup itself will refuse without
  const need = ["businessName", "country", "msbNumber", "ownerName", "email", "slug", "password", "plan"];
  const missing = need.filter((id) => (resolved[id]?.value ?? null) === null);
  return { ok: missing.length === 0, missing };
}
