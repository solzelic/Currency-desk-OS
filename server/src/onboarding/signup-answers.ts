/* ============================================================
   Sign-up v2.1, chapters 2 to 4: what each screen may save
   (SIGNUP-LOGIC §4; build doc §3, §6).

   Each screen saves on Continue (PUT …/answers). The server takes only the
   fields that screen asks for, under the design's own names (the same
   names provisioning already reads: onboarding/provision.ts), each parsed
   to a known shape at the edge (standards §2). Anything else is dropped.
   Secrets cannot be saved here at all: no password, PIN, code or card
   field is in any screen's list.

   The step names are the prototype's states (reference/tools/capture.cjs),
   so `last_step` is a screen the page knows how to reopen.
   ============================================================ */
import { z } from "zod";

const text = (max = 200) => z.string().trim().max(max);
const flag = z.boolean();

const teamMember = z.object({
  first: text(60), last: text(60), name: text(121).optional(),
  /* the six role cards (prototype ROLES) */
  role: z.enum(["Manager", "Compliance officer", "Senior teller", "Cashier", "Bookkeeper", "Trainee"]),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(254)]).optional(),
  phone: text(30).optional(),
  mode: z.enum(["email", "noemail", "none"]).optional(),
}).strict();

const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const minorAmount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
/* The vault count: per currency, either a typed total or notes by
   denomination (value → how many), plus coins. Amounts are decimal strings,
   never floats (standards §3). */
const vaultEntry = z.object({
  mode: z.enum(["notes", "total", "none"]),
  notes: z.record(z.string().regex(/^\d{1,6}(\.\d{1,2})?$/), z.number().int().min(0).max(1_000_000)).optional(),
  coins: minorAmount.optional(),
  total: minorAmount.optional(),
  done: flag.optional(),
}).strict();

export const STEP_FIELDS = {
  "08-shop-name": z.object({ operatingName: text(120), bizName: text(160), nameOk: flag, legalOk: flag }).partial(),
  "09-address": z.object({
    street: text(160), unit: text(40), city: text(80), region: text(80), postal: text(16),
    country_addr: text(80), addrVerified: flag, addrManual: flag,
  }).partial(),
  "10-shops": z.object({ shops: z.enum(["one", "more"]) }).partial(),
  "11-shops-more": z.object({ shops: z.enum(["one", "more"]), shopCount: z.number().int().min(2).max(50) }).partial(),
  "12-registration": z.object({ msbNumber: text(40), regSkipped: flag }).partial(),
  "14-currencies": z.object({ currencies: z.array(currencyCode).max(200) }).partial(),
  "15-count": z.object({ count: z.record(currencyCode, vaultEntry), countLater: flag }).partial(),
  "18-officer": z.object({ complianceMode: z.enum(["me", "else"]), compName: text(120), compEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(254)]) }).partial(),
  "19-idline": z.object({ idOver: z.string().regex(/^\d{1,9}$/), idCustom: z.string().regex(/^\d{0,9}$/) }).partial(),
  "20-team": z.object({ team: z.array(teamMember).max(50) }).partial(),
  "21-add-person": z.object({ team: z.array(teamMember).max(50) }).partial(),
} as const;

export type AnswerStep = keyof typeof STEP_FIELDS;

/** Every screen a person can stop on, in order, so `last_step` is one the page can reopen. */
export const RESUMABLE_STEPS = [
  "06-pin-intro", "07-pin", "08-shop-name", "09-address", "10-shops", "11-shops-more", "12-registration",
  "13-money", "14-currencies", "15-count", "16-online", "17-rules", "18-officer", "19-idline",
  "20-team", "21-add-person", "22-confirm",
] as const;
export type ResumableStep = (typeof RESUMABLE_STEPS)[number];

export const answersBody = z.object({
  step: z.enum(RESUMABLE_STEPS),
  answers: z.record(z.string().max(60), z.unknown()).default({}),
});

export type ParsedAnswers =
  | { ok: true; step: ResumableStep; values: Record<string, unknown> }
  | { ok: false; detail: string };

/** Keep only what this screen asks for, in the shape it promises. */
export function parseAnswers(step: ResumableStep, answers: Record<string, unknown>): ParsedAnswers {
  const schema = Object.entries(STEP_FIELDS).find(([key]) => key === step)?.[1];
  if (!schema) return { ok: true, step, values: {} };
  const known = Object.keys(schema.shape);
  const picked: Record<string, unknown> = {};
  for (const k of known) if (k in answers) picked[k] = answers[k];
  const parsed = schema.safeParse(picked);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, detail: `${issue?.path.join(".") || "answer"}: ${issue?.message ?? "not valid"}` };
  }
  return { ok: true, step, values: parsed.data };
}

/** The answers a resume may show. The keys are this file's lists, so nothing else leaks back. */
export function resumable(answers: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(Object.values(STEP_FIELDS).flatMap((s) => Object.keys(s.shape)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) if (allowed.has(k)) out[k] = v;
  return out;
}
