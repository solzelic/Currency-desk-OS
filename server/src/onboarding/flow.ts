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

   WHOSE NAMES THESE ARE

   The field ids here are the DESIGN's field ids — operatingName,
   bizName, ownerEmail, idOver, compName, and so on — not a set invented
   alongside them. An earlier version of this file was a nine-step spec
   written before the design existed, and the two surfaces spent their
   time slowly disagreeing about what a desk even has. There is no
   translation layer between the applicant's screens and this file
   because a translation layer is a thing that goes stale silently every
   time a screen changes. The design asks it; this stores it; the panel
   shows the same list back.

   The one place the two surfaces differ on purpose is the password. The
   design puts it on the same screen as the owner's name; here it is its
   own step, because a step is the unit the panel gates on and an
   operator must not be able to type it.
   ============================================================ */

export type FieldType =
  | "text" | "email" | "tel" | "select" | "number" | "money" | "currencies"
  | "password" | "percent" | "boolean" | "team" | "table";

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
  /* Which screen of the applicant's flow this is, so the panel can sit the
     two side by side and an operator on the phone can say "you're on the
     one about spreads" without translating. */
  screen: number | null;
  fields: Field[];
}

/* The design's own four, in its own order. */
export const PHASES = [
  { id: "business", title: "Business" },
  { id: "money", title: "Money" },
  { id: "rules", title: "Rules" },
  { id: "launch", title: "Launch" },
];

/* The jurisdictions the design offers, with the numbers it quotes. `report`
   is the threshold the regulator sets and we cannot move; `idOver` — the
   point at which the desk asks for ID — is the shop's own choice, which
   the design defaults to the regulator's number and lets them tighten. */
export const JURISDICTION: Record<
  string,
  { country: string; regulator: string; regLabel: string; currency: string; reportThreshold: number; reportCurrency: string; report: string }
> = {
  CA: { country: "Canada", regulator: "FINTRAC", regLabel: "FINTRAC registration number", currency: "CAD", reportThreshold: 10000, reportCurrency: "CAD", report: "Large Cash Transaction Report" },
  US: { country: "United States", regulator: "FinCEN", regLabel: "FinCEN MSB registration number", currency: "USD", reportThreshold: 10000, reportCurrency: "USD", report: "Currency Transaction Report" },
  GB: { country: "United Kingdom", regulator: "HMRC", regLabel: "HMRC money-service business number", currency: "GBP", reportThreshold: 10000, reportCurrency: "GBP", report: "Suspicious Activity Report" },
  AU: { country: "Australia", regulator: "AUSTRAC", regLabel: "AUSTRAC enrolment number", currency: "AUD", reportThreshold: 10000, reportCurrency: "AUD", report: "Threshold Transaction Report" },
  AE: { country: "United Arab Emirates", regulator: "CBUAE", regLabel: "Exchange-house licence number", currency: "AED", reportThreshold: 55000, reportCurrency: "AED", report: "Suspicious Transaction Report" },
  EU: { country: "European Union", regulator: "National FIU", regLabel: "AML registration number", currency: "EUR", reportThreshold: 10000, reportCurrency: "EUR", report: "Suspicious Transaction Report" },
  XX: { country: "Somewhere else", regulator: "your regulator", regLabel: "Business / AML registration number", currency: "USD", reportThreshold: 10000, reportCurrency: "USD", report: "large-transaction report" },
};

const COUNTRIES = Object.entries(JURISDICTION).map(([value, j]) => ({ value, label: j.country }));

/* The design's plans, at the design's prices. Held here as well because
   this is what the desk is created on, and a plan id the browser made up
   must not become a tenant's plan. */
export const PLANS = [
  { value: "rates", label: "Rates", monthly: 299 },
  { value: "full", label: "Full System", monthly: 499 },
  { value: "ai", label: "AI Bundle", monthly: 749 },
];

export const ADDONS = [
  { value: "website", label: "Custom website & rate connection", once: 3500 },
  { value: "onsite", label: "On-site setup week", once: 5000 },
];

export const ROLES = ["Manager", "Compliance officer", "Senior teller", "Cashier", "Bookkeeper", "Trainee"];

export const STEPS: Step[] = [
  {
    id: "jurisdiction",
    phase: "business", screen: 1,
    title: "Where you operate",
    blurb: "Sets the regulator, the home currency and the reporting threshold — so the desk fits their rules, not someone else's.",
    kind: "form", who: "either",
    fields: [
      { id: "country", label: "Licensed in", type: "select", required: true, options: COUNTRIES, prefillFrom: "application.jurisdiction" },
      { id: "elseCountry", label: "Country (if somewhere else)", type: "text", help: "Only when the country above is “Somewhere else”." },
      { id: "elseReg", label: "Their regulator", type: "text" },
      { id: "elseCcy", label: "Their home currency", type: "text", placeholder: "USD" },
      { id: "regulator", label: "Regulator", type: "text", derived: true, help: "Follows from the country — this is the rulebook the desk carries." },
      { id: "homeCurrency", label: "Home currency", type: "text", derived: true },
      { id: "reportThreshold", label: "Reports over", type: "money", derived: true, help: "The regulator's number. Not ours to move." },
    ],
  },
  {
    id: "shop",
    phase: "business", screen: 2,
    title: "The shop",
    blurb: "The name on the door, and the registered entity behind it.",
    kind: "form", who: "either",
    fields: [
      { id: "operatingName", label: "Shop name (on the door)", type: "text", required: true, placeholder: "York Currency Exchange" },
      { id: "bizName", label: "Registered legal name", type: "text", required: true, placeholder: "York Foreign Exchange Inc." },
    ],
  },
  {
    id: "address",
    phase: "business", screen: 3,
    title: "Where the shop is",
    blurb: "The storefront address — it prints on receipts and reports.",
    kind: "form", who: "either",
    fields: [
      { id: "street", label: "Street address", type: "text", required: true },
      { id: "city", label: "City", type: "text", required: true },
      { id: "postal", label: "Postal / ZIP", type: "text", required: true },
      { id: "region", label: "State / province", type: "text" },
      { id: "country_addr", label: "Country", type: "text" },
    ],
  },
  {
    id: "registration",
    phase: "business", screen: 4,
    title: "Registration",
    blurb: "Their money-services registration. Optional here — plenty of shops apply before the number lands.",
    kind: "form", who: "either",
    fields: [
      { id: "msbNumber", label: "Registration number", type: "text", placeholder: "M21-0098765" },
    ],
  },
  {
    id: "account",
    phase: "business", screen: 5,
    title: "The owner",
    blurb: "The account everything below it answers to.",
    kind: "form", who: "either",
    fields: [
      { id: "ownerName", label: "Owner's name", type: "text", required: true, prefillFrom: "application.name" },
      { id: "ownerEmail", label: "Email", type: "email", required: true, prefillFrom: "application.email", help: "This is their sign-in, and where the confirmation code goes." },
      { id: "phone", label: "Mobile", type: "tel", help: "Collected now; it becomes the confirmation channel when we can send to a phone." },
    ],
  },
  {
    id: "password",
    phase: "business", screen: 5,
    title: "Their password",
    blurb: "Set by the owner, on their own screen. Nobody else can do this one — including us.",
    kind: "form", who: "customer",
    fields: [
      { id: "ownerPass", label: "Password", type: "password", required: true, help: "At least 6 characters." },
    ],
  },
  {
    id: "currencies",
    phase: "money", screen: 6,
    title: "What they trade",
    blurb: "Every currency they buy or sell. The home currency is always in.",
    kind: "form", who: "either",
    fields: [
      { id: "currencies", label: "Currencies", type: "currencies", required: true, placeholder: "USD, EUR, GBP" },
    ],
  },
  {
    id: "spreads",
    phase: "money", screen: 7,
    title: "Margin",
    blurb: "What they add over the market rate. One number for everything, or one per currency.",
    kind: "form", who: "either",
    fields: [
      { id: "sameSpread", label: "One spread for everything", type: "boolean" },
      { id: "spreadAll", label: "Spread", type: "percent", placeholder: "2.0" },
      { id: "spreads", label: "Per currency", type: "table", help: "Currency code → spread, when they are not all the same." },
    ],
  },
  {
    id: "float",
    phase: "money", screen: 8,
    title: "Opening float",
    blurb: "Roughly what is in the drawer per currency. Optional — the first count trues it up.",
    kind: "form", who: "either",
    fields: [
      { id: "float", label: "Float", type: "table", help: "Currency code → opening amount." },
    ],
  },
  {
    id: "compliance",
    phase: "rules", screen: 9,
    title: "Compliance officer",
    blurb: "The one named person the regulator expects to answer for anti-money-laundering.",
    kind: "form", who: "either",
    fields: [
      { id: "compName", label: "Name", type: "text", required: true },
      { id: "compEmail", label: "Email", type: "email", required: true },
      { id: "complianceMode", label: "Who", type: "select", options: [{ value: "me", label: "The owner" }, { value: "other", label: "Somebody else" }] },
    ],
  },
  {
    id: "idpolicy",
    phase: "rules", screen: 10,
    title: "When ID is asked for",
    blurb: "The regulator sets a ceiling; plenty of shops ask earlier. This is their choice, not ours.",
    kind: "form", who: "either",
    fields: [
      { id: "idOver", label: "Take ID over", type: "money", required: true, help: "Defaults to the regulator's threshold." },
    ],
  },
  {
    id: "team",
    phase: "rules", screen: 11,
    title: "The team",
    blurb: "Everyone else on the counter, and what each of them may reach.",
    kind: "form", who: "either",
    fields: [
      { id: "team", label: "Staff", type: "team", help: "Name, role and email. Each gets their own login when the desk opens." },
    ],
  },
  {
    id: "publish",
    phase: "launch", screen: 12,
    title: "Public rate board",
    blurb: "Where their rates should show up besides their own page.",
    kind: "form", who: "either",
    fields: [
      { id: "siteMode", label: "Their site", type: "select", options: [
        { value: "have", label: "They have a site" },
        { value: "want", label: "They want one building" },
        { value: "none", label: "Page only, no site" },
      ] },
      { id: "website", label: "Their website", type: "text", placeholder: "yorkexchange.ca" },
      { id: "webPerson", label: "Who looks after it", type: "text" },
      { id: "webEmail", label: "Their email", type: "email" },
    ],
  },
  {
    id: "plan",
    phase: "launch", screen: 15,
    title: "Plan",
    blurb: "What they are signing up for. This is what gets charged.",
    kind: "form", who: "either",
    fields: [
      { id: "plan", label: "Plan", type: "select", required: true, options: PLANS.map((p) => ({ value: p.value, label: `${p.label} — $${p.monthly}/mo` })) },
      { id: "term", label: "Billed", type: "select", options: [{ value: "annual", label: "Annually" }, { value: "monthly", label: "Monthly" }] },
      { id: "addons", label: "Add-ons", type: "table", help: "website / onsite → whether they took it." },
      { id: "promo", label: "Promo code", type: "text" },
    ],
  },
  {
    id: "documents",
    phase: "launch", screen: null,
    title: "Paperwork",
    blurb: "Registration certificate and owner ID, so the desk is who it says it is.",
    kind: "documents", who: "either",
    fields: [],
  },
  {
    id: "payment",
    phase: "launch", screen: 15,
    title: "Payment",
    blurb: "The last thing before the doors open. The card is taken in the browser and never reaches us.",
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
export function fromApplication(
  app: { name?: string | null; email?: string | null; details?: Record<string, unknown> | null } | null,
): Answers {
  if (!app) return {};
  const d = (app.details ?? {}) as Record<string, unknown>;
  const out: Answers = {};
  if (app.name) out.ownerName = app.name;
  if (app.email) out.ownerEmail = app.email;
  if (typeof d.jurisdiction === "string" && JURISDICTION[d.jurisdiction]) out.country = d.jurisdiction;
  /* "none yet" is what the application form stores when somebody says they
     have no site — carrying that through as a website would be a lie. */
  if (typeof d.website === "string" && d.website && d.website !== "none yet") out.website = d.website;
  return out;
}

/* What follows from what has been answered. Kept separate from the answers
   themselves so that changing the country moves the regulator with it,
   instead of leaving a stale value somebody has to notice. */
export function derive(a: Answers): Answers {
  const id = String(a.country ?? "");
  const j = JURISDICTION[id];
  if (!j) return {};
  /* "Somewhere else" means we genuinely do not know their regulator, so the
     flow asks — and what they type is what the desk carries. */
  if (id === "XX") {
    return {
      regulator: (a.elseReg as string) || j.regulator,
      homeCurrency: (a.elseCcy as string) || j.currency,
      reportThreshold: j.reportThreshold,
      reportName: j.report,
      regLabel: j.regLabel,
    };
  }
  return {
    regulator: j.regulator,
    homeCurrency: j.currency,
    reportThreshold: j.reportThreshold,
    reportName: j.report,
    regLabel: j.regLabel,
  };
}

/* One value, and where it came from — so a screen can say "we already knew
   this" rather than presenting our guess as their answer. */
export interface Resolved { value: unknown; source: Source | null }

const blank = (v: unknown): boolean =>
  v === undefined || v === null || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

export function resolve(entered: Answers, application: Answers): Record<string, Resolved> {
  const merged: Answers = { ...application, ...entered };
  const derived = derive(merged);
  const out: Record<string, Resolved> = {};
  for (const f of ALL_FIELDS) {
    if (f.id in entered && !blank(entered[f.id])) {
      out[f.id] = { value: entered[f.id], source: "entered" };
    } else if (f.derived && f.id in derived) {
      out[f.id] = { value: derived[f.id], source: "derived" };
    } else if (f.id in application && !blank(application[f.id])) {
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

/* What the desk genuinely cannot be created without. Deliberately shorter
   than the list of things the flow asks: a registration number that has not
   come through yet, or an empty float, should not hold a shop's doors shut. */
export function canCreateDesk(resolved: Record<string, Resolved>): { ok: boolean; missing: string[] } {
  const need = ["operatingName", "bizName", "country", "ownerName", "ownerEmail", "ownerPass", "plan"];
  const missing = need.filter((id) => (resolved[id]?.value ?? null) === null);
  return { ok: missing.length === 0, missing };
}
