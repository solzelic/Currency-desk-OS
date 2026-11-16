/* ============================================================
   Staging "Start on Day 1" (routes/staging-day-one.ts): a brand-new
   synthetic shop, signed up by the server, so the post-payment
   onboarding (Day 1, Build my desk, the tour, the first apps) can be
   tried at once.

   It is the staging door's own reservation (onboarding/signup-staging.ts)
   driven through the real v2.1 services, in the order the page calls
   them, with their own checks, assent text and hashes:
     reservation (as the ticket branch of POST /api/enquiries writes it),
     invited at once → password credential → the 6-digit code, on screen
     and never mailed → verify (the enrolment session) → PIN → the
     chapters → the signature → the plan with the call off, staging, no
     card. It stops where a staging owner stands just before Open. The
     page then asks the existing /resume, /staging-open and /open on the
     enrolment cookie, and the desk opens as a test shop.

   No person reads the declaration or the plan here: the server signs as
   "Staging Owner" for its own synthetic fixture only, and records
   staging.day_one so the records say where they came from.

   Nothing here calls Stripe, a mailer or the network, or posts to the
   ledger. The password and PIN are generated here, stored only as
   Argon2id hashes, and handed back once to the caller.
   ============================================================ */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { hashSignupSecret, temporaryPassword } from "../auth/password.js";
import { stagingDoorOpen, type StagingDoorHeaders } from "../auth/staging-runtime.js";
import { issueCdId } from "../enquiries/cd-id.js";
import { normalizeMsb } from "../enquiries/msb.js";
import { answersOf, v21Details, waitlistFor } from "../enquiries/v21.js";
import { forgetClaimedCount, STAGING_DOOR_REASON } from "../routes/early-access.js";
import { makeReference, normalizePhone } from "../routes/enquiries.js";
import { freshStagingIdentity, type StagingIdentity } from "../routes/staging-fresh-shop.js";
import { operatingNameOf } from "./cd-id-door.js";
import { sendSignupCode, verifySignupCode, type Mailer } from "./email-code.js";
import { lengthOf, localRefusal, MAX_LENGTH, MIN_LENGTH } from "./password-rule.js";
import { moveTo } from "./pipeline.js";
import { saveCredential, sha256 } from "./signup-account.js";
import { parseAnswers, saveSignupAnswers, type ResumableStep } from "./signup-answers.js";
import { confirmDesk, prepareStagingPlan, type PlanChoice } from "./signup-open.js";
import { signupPack } from "./signup-pack.js";
import { checkPin, pinStrength, savePin } from "./signup-pin.js";
import { stopSignupCalls } from "./signup-preferences.js";
import { databaseMarkedStaging, stagingSignupFixture } from "./signup-staging.js";

type Enquiry = typeof schema.enquiries.$inferSelect;

export const DAY_ONE_OWNER = "Staging Owner";

/* What the plan screen sends by default: AI plan, monthly, the brief on,
   the call off (a do-not-contact row has no call), no add-ons. */
export const DAY_ONE_PLAN: PlanChoice = { plan: "ai", term: "monthly", locations: 1, brief: true, call: false, website: false, setupWeek: false };

const dayOneShopName = (identity: StagingIdentity): string => `Staging Shop ${identity.hex.slice(0, 4).toUpperCase()}`;

/** The Early Access v2.1 application, as the page would post it: a one-shop
    Ontario exchange, FINTRAC registration in progress, no call. */
export function dayOneApplication(identity: StagingIdentity) {
  return {
    firstName: "Staging", lastName: "Owner", shopName: dayOneShopName(identity),
    workspace: `${identity.slug}.currencydeskos.com`, website: "none yet", mode: "early_access",
    jurisdiction: "CA", province: "ON", country: "Canada", state: null,
    fintracRegistered: "In progress", msbNumber: null, waitlist: false, waitlistReason: null,
    role: "Owner", employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single",
    runningOn: "Spreadsheets", timeline: "This month", phone: "+1 416 555 0100", bestTime: "no call", samConsent: null,
  };
}

/** The chapters, screen by screen, as PUT …/answers takes them. The desk
    follows the pack's ID line; CAD is added from the pack at activation. */
export function dayOneAnswers(shopName: string): [ResumableStep, Record<string, unknown>][] {
  return [
    ["08-shop-name", { operatingName: shopName, bizName: `${shopName} Inc.`, nameOk: true, legalOk: true }],
    ["09-address", { street: "100 Queen St W", city: "Toronto", region: "ON", postal: "M5H 2N2", country_addr: "Canada", addrManual: true }],
    ["10-shops", { shops: "one" }],
    ["12-registration", { regSkipped: true }],
    ["14-currencies", { currencies: ["USD", "EUR"] }],
    ["15-count", { count: {
      CAD: { mode: "total", total: "2000.00", done: true },
      USD: { mode: "total", total: "500.00", done: true },
      EUR: { mode: "total", total: "300.00", done: true },
    } }],
    ["18-officer", { complianceMode: "me" }],
    ["19-idline", { idOver: String(signupPack("CA").idLine.legal) }],
    ["20-team", { team: [] }],
  ];
}

/* The password rule's local checks. The remote breach lookup is not asked:
   this is 14 random characters from temporaryPassword, so it cannot be in a
   leak, and an unauthenticated press should not make an outbound call. */
function dayOnePassword(shopName: string): string | null {
  for (let k = 0; k < 3; k++) {
    const pw = temporaryPassword();
    const n = lengthOf(pw);
    if (n >= MIN_LENGTH && n <= MAX_LENGTH && !localRefusal(pw, shopName)) return pw;
  }
  return null;
}

/* A PIN the sign-up accepts and the desk's own PIN change calls strong:
   never 1234, a repeat, a run or a year. */
function dayOnePin(): string | null {
  for (let k = 0; k < 200; k++) {
    const pin = String(randomInt(0, 10_000)).padStart(4, "0");
    if (checkPin(pin, pin).ok && pinStrength(pin) === "strong") return pin;
  }
  return null;
}

/* The code is handed back on screen, so nothing is ever mailed. */
const neverMail: Mailer = async () => { throw new Error("staging_day_one_never_mails"); };

type Step = "application" | "reservation" | "invite" | "credential" | "code" | "verify" | "pin" | "answers" | "confirm" | "plan" | "audit";
export type DayOneRefusal = "door" | "db_unmarked" | "identity" | "password_rule" | "pin_rule" | "fixture" | `step_${Step}`;
export type DayOneResult =
  | { ok: true; cdId: string; operatingName: string; token: string; signIn: { email: string; password: string; pin: string } }
  | { ok: false; reason: DayOneRefusal };

/* The reservation as it stands now, only while it is still the door's own
   invited fixture on this request's door and database. */
async function still(db: Db, id: string, headers: StagingDoorHeaders, env: NodeJS.ProcessEnv): Promise<Enquiry | null> {
  const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, id)).limit(1))[0];
  return row && row.status === "invited" && (await stagingSignupFixture(db, row, headers, env)) ? row : null;
}

/** One new staging shop, signed up to the point before Open. A refusal
    carries a bounded reason only; anything thrown is a refusal at the step
    it was thrown in. A refusal after the reservation leaves an invited
    do-not-contact synthetic row and no desk, like an abandoned walkthrough. */
export async function prepareStagingDayOne(db: Db, headers: StagingDoorHeaders, env: NodeJS.ProcessEnv = process.env): Promise<DayOneResult> {
  const refuse = (reason: DayOneRefusal): DayOneResult => ({ ok: false, reason });
  let step: Step = "application";
  try {
    /* Gates first, before anything is written. */
    if (!stagingDoorOpen({ host: headers.host }, env)) return refuse("door");
    if (!(await databaseMarkedStaging(db))) return refuse("db_unmarked");
    const identity = await freshStagingIdentity(db);
    if (!identity) return refuse("identity");
    const password = dayOnePassword(dayOneShopName(identity));
    if (!password) return refuse("password_rule");
    const pin = dayOnePin();
    if (!pin) return refuse("pin_rule");

    /* The application, parsed by the same strict shape the page posts to. */
    const typed = v21Details.parse(dayOneApplication(identity));
    const msb = normalizeMsb(typed.msbNumber);
    if (!msb.ok) return refuse("step_application");
    const v21 = { ...typed, msbNumber: msb.value };
    if (waitlistFor(v21)) return refuse("step_application");
    const kept: Record<string, unknown> = { ...answersOf(v21), stagingFresh: true, slug: identity.slug };
    const tel = normalizePhone(kept.phone);
    if (!tel?.ok) return refuse("step_application");
    kept.phone = tel.phone;

    /* The reservation, as the ticket branch of POST /api/enquiries writes
       it: no founding number, do not contact, no consent, no growth job,
       no operator mail, invited at once and quietly. */
    step = "reservation";
    const cdId = await issueCdId(db, [v21.shopName, v21.workspace.split(".")[0] ?? "", `${v21.firstName} ${v21.lastName}`]);
    forgetClaimedCount();
    const [inserted] = await db.insert(schema.enquiries).values({
      id: randomUUID(), reference: makeReference(), kind: "early_access", email: identity.email, name: DAY_ONE_OWNER,
      details: kept, charterNo: null, doNotContact: true, doNotContactReason: STAGING_DOOR_REASON,
      cdId, waitlistReason: null, inviteCode: null, placeInLine: null,
    }).returning();
    if (!inserted) return refuse("step_reservation");
    step = "invite";
    if (!(await moveTo(db, inserted, "invited", "system", { quiet: true })).ok) return refuse("step_invite");

    /* How will you sign in: a password, bound to an attempt only this
       process holds (no attempt cookie leaves the server). */
    step = "credential";
    let row = await still(db, inserted.id, headers, env);
    if (!row) return refuse("fixture");
    const attemptHash = sha256(randomBytes(32).toString("base64url"));
    if (!(await saveCredential(db, row.id, { kind: "password", attemptHash, passwordHash: await hashSignupSecret(password) }, cdId))) return refuse("step_credential");

    /* Check your inbox: the ordinary code, limits and hash, on screen. */
    step = "code";
    row = await still(db, row.id, headers, env);
    if (!row) return refuse("fixture");
    const sent = await sendSignupCode(db, row, operatingNameOf(row), neverMail, Date.now(), { onScreen: true });
    if (!sent.sent || sent.delivery !== "on_screen") return refuse("step_code");
    step = "verify";
    const verified = await verifySignupCode(db, row.id, attemptHash, sent.code, Date.now(), cdId);
    if (!verified.ok) return refuse("step_verify");

    step = "pin";
    if (!(await savePin(db, row.id, pin))) return refuse("step_pin");

    step = "answers";
    for (const [screen, answers] of dayOneAnswers(dayOneShopName(identity))) {
      const parsed = parseAnswers(screen, answers);
      if (!parsed.ok || !(await saveSignupAnswers(db, row.id, parsed))) return refuse("step_answers");
    }

    step = "confirm";
    if (!(await confirmDesk(db, row.id, DAY_ONE_OWNER))) return refuse("step_confirm");

    /* The plan, as POST …/plan prepares it for the fixture: the call
       stopped, then the staging plan with no card processor. */
    step = "plan";
    await stopSignupCalls(db, row.id);
    row = await still(db, row.id, headers, env);
    if (!row) return refuse("fixture");
    await prepareStagingPlan(db, row, DAY_ONE_PLAN);

    step = "audit";
    await audit(db, { tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", action: "staging.day_one", detail: { enquiryId: row.id } });
    return { ok: true, cdId, operatingName: dayOneShopName(identity), token: verified.token, signIn: { email: identity.email, password, pin } };
  } catch {
    return refuse(`step_${step}`);
  }
}
