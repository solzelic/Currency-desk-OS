/* ============================================================
   Turning answers into a desk.

   Two doors lead here and they must not build different things:

     · /api/signup/verify        — somebody who signed up directly
     · /api/onboarding/:ref/launch — somebody finishing the designed flow

   Before this file existed only the first one could create anything, so
   the designed flow ended on a screen that said "You're live" over a
   database in which nothing had happened. The creation itself is now one
   function, and both doors call it.

   `specFromAnswers` is the other half: the design's field names on one
   side, the tenant/entity/branch/workspace hierarchy on the other. It is
   the only place that translation happens.
   ============================================================ */
import { and, eq, notInArray, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import { publishStartingBoard, seedOpeningFloat } from "../rates/starting-board.js";
import { packForCountry } from "../ledger/jurisdiction.js";
import type { Db } from "../db/index.js";
import { audit } from "../audit.js";
import { JURISDICTION, type Resolved } from "./flow.js";

/* The design sells three plans; the server gates on three tiers. They are
   not the same axis — "AI Bundle" is Full System plus an assistant, not a
   fourth level of access — so the bundle is recorded as a flag and both
   full tiers entitle the whole desk. Under-entitling somebody who has just
   paid for "the complete exchange desk" is the worse way to be wrong. */
const PLAN_TIER: Record<string, "basic" | "pro" | "premium"> = {
  rates: "basic",
  full: "pro",
  ai: "premium",
};

/* The design's role names are the ones a shop owner uses. The system's are
   the ones authorization is written against. */
const ROLE_MAP: Record<string, typeof schema.staffRole.enumValues[number]> = {
  "Manager": "branch_manager",
  "Compliance officer": "compliance_officer",
  "Senior teller": "supervisor",
  "Cashier": "teller",
  "Bookkeeper": "auditor",
  "Trainee": "teller",
};

const RESERVED_SLUGS = new Set([
  "api", "app", "www", "sites", "admin", "administrator", "currencydesk", "static",
  "assets", "os-src", "public", "help", "support", "status", "signup", "login", "onboarding",
]);

/* "York Currency Exchange" → "york-currency-exchange". The design never asks
   for a desk address — it shows one derived from the shop name — so this is
   where that promise is kept. */
export function slugFrom(name: string): string {
  const s = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s.length >= 2 ? s : "";
}

export interface TeamMember { name: string; role: string; email: string }

export interface DeskSpec {
  businessName: string;
  legalName: string;
  ownerName: string;
  email: string;
  slug: string;
  plan: string;
  /* Everything the design collected, kept whole. This is what lands on
     tenants.setup, and it is deliberately the design's own field names —
     a desk should be able to say what it was set up as. */
  setup: Record<string, unknown>;
  msbNumber: string | null;
  regulator: string;
  team: TeamMember[];
}

const str = (r: Record<string, Resolved>, id: string): string =>
  typeof r[id]?.value === "string" ? (r[id]!.value as string).trim() : "";

/* Build the spec from resolved answers. Resolved, not raw, so that the
   regulator and home currency that follow from the country come along
   without anybody having typed them. */
export function specFromAnswers(
  resolved: Record<string, Resolved>,
  application?: { details?: Record<string, unknown> | null } | null,
): DeskSpec {
  const country = str(resolved, "country") || "CA";
  const j = JURISDICTION[country] ?? JURISDICTION.CA!;
  const businessName = str(resolved, "operatingName");
  const legalName = str(resolved, "bizName") || businessName;

  /* The address they picked on the application is the one they have been
     told they are getting, so it wins over one derived from the shop name. */
  const applied = (application?.details ?? {}) as Record<string, unknown>;
  const fromApplication =
    typeof applied.workspace === "string" && applied.workspace
      ? slugFrom(applied.workspace.split(".")[0]!)
      : "";
  let slug = fromApplication || slugFrom(businessName);
  if (!slug || RESERVED_SLUGS.has(slug)) slug = slugFrom(businessName + "-fx") || "desk";

  const planId = str(resolved, "plan") || "full";
  const teamRaw = resolved.team?.value;
  const team: TeamMember[] = Array.isArray(teamRaw)
    ? (teamRaw as unknown[])
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => ({
          name: String(m.name ?? "").trim(),
          role: String(m.role ?? "Cashier"),
          email: String(m.email ?? "").trim().toLowerCase(),
        }))
        .filter((m) => m.name.length > 0)
    : [];

  const val = (id: string): unknown => resolved[id]?.value ?? null;

  return {
    businessName,
    legalName,
    ownerName: str(resolved, "ownerName"),
    email: str(resolved, "ownerEmail").toLowerCase(),
    slug,
    plan: PLAN_TIER[planId] ?? "premium",
    msbNumber: str(resolved, "msbNumber") || null,
    regulator: str(resolved, "regulator") || j.regulator,
    team,
    /* The whole picture, in the design's own words. A desk that cannot say
       what spread it opened on, or who its compliance officer is, has
       thrown away the only time anybody was going to tell us. */
    setup: {
      plan: planId,
      planTier: PLAN_TIER[planId] ?? "premium",
      aiBundle: planId === "ai",
      term: val("term") ?? "annual",
      addons: val("addons") ?? {},
      promo: val("promo") ?? "",

      country,
      regulator: str(resolved, "regulator") || j.regulator,
      homeCurrency: str(resolved, "homeCurrency") || j.currency,
      reportThreshold: val("reportThreshold") ?? j.reportThreshold,
      reportName: val("reportName") ?? j.report,
      idThreshold: Number(val("idOver")) || j.reportThreshold,

      operatingName: businessName,
      bizName: legalName,
      msbNumber: str(resolved, "msbNumber"),
      address: {
        street: str(resolved, "street"), city: str(resolved, "city"),
        region: str(resolved, "region"), postal: str(resolved, "postal"),
        country: str(resolved, "country_addr") || j.country,
      },

      phone: str(resolved, "phone"),
      compliance: {
        name: str(resolved, "compName"), email: str(resolved, "compEmail"),
        mode: str(resolved, "complianceMode") || "other",
      },

      currencies: val("currencies") ?? [],
      sameSpread: val("sameSpread") ?? true,
      spreadAll: val("spreadAll") ?? "2.0",
      spreads: val("spreads") ?? {},
      openingFloat: val("float") ?? {},

      publish: {
        mode: str(resolved, "siteMode") || "none",
        website: str(resolved, "website"),
        contactName: str(resolved, "webPerson"),
        contactEmail: str(resolved, "webEmail"),
      },

      team,
    },
  };
}

export async function slugTaken(db: Db, slug: string, exceptEmail?: string): Promise<boolean> {
  const asTenant = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.siteSlug, slug)).limit(1);
  if (asTenant.length) return true;
  const asPending = await db.select({ email: schema.pendingSignups.email }).from(schema.pendingSignups).where(eq(schema.pendingSignups.slug, slug));
  return asPending.some((p) => p.email !== exceptEmail);
}

/* Find a free address rather than refusing. Somebody at the end of a
   fifteen-screen setup should not be sent back because another shop is
   also called Currency Exchange. */
export async function freeSlug(db: Db, wanted: string, email: string): Promise<string> {
  if (wanted && !(await slugTaken(db, wanted, email))) return wanted;
  for (let n = 2; n < 60; n++) {
    const candidate = `${wanted}-${n}`.slice(0, 40).replace(/-+$/, "");
    if (!(await slugTaken(db, candidate, email))) return candidate;
  }
  return `${wanted}-${Date.now().toString(36)}`.slice(0, 40);
}

export interface Provisioned {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  ownerId: string;
  slug: string;
  staffCreated: number;
}

/* The identification line an owner picked during onboarding, as a desk
   override — or null, meaning "follow the pack", which is the truthful
   state for every answer that is not a real tightening. See the call site
   for why, and docs/DESK_THRESHOLDS.md for the rule.

   The pack's own figure is read rather than kept in a second table here,
   because a duplicated threshold is exactly the kind of copy that drifts.
   Where the packs cannot be read at all — the embedded database used in
   development and tests carries no `jurisdiction_packs` — no override is
   recorded, which leaves the desk following its pack. That is the safe
   direction to be wrong in: a desk that follows its regulator. */
async function idThresholdFromSetup(
  setup: unknown,
  packId: string,
  db: Db,
): Promise<string | null> {
  const chosen = Number((setup as Record<string, unknown> | null)?.idThreshold);
  if (!Number.isFinite(chosen) || chosen <= 0) return null;
  let mandate: number | null = null;
  try {
    const found = await db.execute(
      sql`SELECT id_threshold FROM jurisdiction_packs WHERE pack_id = ${packId}`,
    );
    const rows = (Array.isArray(found) ? found : (found as { rows?: unknown[] }).rows) ?? [];
    const value = Number((rows[0] as { id_threshold?: unknown } | undefined)?.id_threshold);
    mandate = Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
  if (mandate === null || chosen >= mandate) return null;
  return chosen.toFixed(2);
}

/* Create the desk. Everything here is onConflictDoNothing, so a retry after
   a dropped connection finishes the job rather than half-failing on the
   first row that already exists. */
export async function provisionDesk(
  db: Db,
  spec: DeskSpec,
  passwordHash: string,
  via: string,
): Promise<Provisioned> {
  const slug = spec.slug;
  const tenantId = "tnt-" + slug;
  const legalEntityId = "le-" + slug;
  const branchId = "br-" + slug + "-main";
  const workspaceId = "ws-" + slug + "-till-01";

  await db.insert(schema.tenants).values({
    id: tenantId, name: spec.businessName, plan: spec.plan, siteSlug: slug, setup: spec.setup,
  }).onConflictDoNothing();
  /* The country they picked installs the jurisdiction: its regulator, its
     reporting thresholds, and the currency this desk keeps its books in.
     Nothing downstream asks "is this Canada" — it asks the pack. */
  const pack = packForCountry((spec.setup as Record<string, unknown>)?.country as string);
  /* "When should the desk ask for ID?" — screen four of onboarding, and the
     answer used to land in `tenants.setup` and stop there. The browser read
     it once into its own saved state on first run; the ledger, which is
     what actually REFUSES a deal for an unidentified customer, never saw it
     at all and compared against a hardcoded 3,000.

     So the answer becomes the desk's real line, on the legal entity, where
     the posting path resolves it — and where the owner can move it again
     later, which is the other half of what they asked for. See
     docs/DESK_THRESHOLDS.md.

     Written ONLY where it is a genuine tightening. The picker's top option
     is worded "the legal minimum — nothing extra", which is a desk saying
     "follow my regulator" rather than a desk pinning a figure; recorded as
     an override it would stop that desk ever being moved by a pack
     correction. And a number ABOVE the pack's cannot be honoured as an
     identification line in any case: it would put a desk out of compliance
     on the day it opened, on the strength of a question it thought it was
     answering about something else. NULL means "follow the pack", and for
     every answer except a real tightening that is the truthful state. */
  const chosenIdLine = await idThresholdFromSetup(spec.setup, pack.packId, db);
  await db.insert(schema.legalEntities).values({
    id: legalEntityId, tenantId, name: spec.legalName, msbNumber: spec.msbNumber, jurisdiction: spec.regulator,
    homeCurrency: pack.homeCurrency,
    jurisdictionPackId: pack.packId,
    jurisdictionPackVersion: pack.version,
    idThreshold: chosenIdLine,
  }).onConflictDoNothing();
  await db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "Main" }).onConflictDoNothing();
  await db.insert(schema.workspaces).values({ id: workspaceId, tenantId, legalEntityId, branchId, tillId: "till-01" }).onConflictDoNothing();

  /* A DESK ARRIVES ABLE TO TRADE.

     It did not before. A newly provisioned desk had no rate board, so its
     first quote failed — while the screen showed another shop's board
     because `/api/rates` fell back to a demo branch. And the opening float
     the owner typed during onboarding was stored in `setup` and applied to
     nothing, so the drawer was empty even though they had said what was in
     it. Both are fixed here, at the moment the desk is made.

     The vault is deliberately NOT seeded: nobody asked what is in their
     safe, and inventing a figure for somebody's cash is exactly what the
     cash-ownership invariants forbid. The Vault screen asks them to count
     it in. */
  const setup = (spec.setup ?? {}) as Record<string, unknown>;
  const board = await publishStartingBoard(db, {
    tenantId, legalEntityId, branchId,
    currencies: Array.isArray(setup.currencies) ? (setup.currencies as string[]) : [],
    homeCurrency: typeof setup.homeCurrency === "string" ? setup.homeCurrency : undefined,
    // the margin they set, shown back to them, and previewed on screen 12
    spreadAll: setup.spreadAll,
  });
  await seedOpeningFloat(db, {
    tenantId, legalEntityId, branchId, workspaceId, tillId: "till-01",
    float: (setup.openingFloat ?? {}) as Record<string, unknown>,
  });

  const ownerId = `${tenantId}:${spec.email}`;
  await db.insert(schema.staffUsers).values({
    id: ownerId,
    tenantId, legalEntityId, branchId,
    staffId: spec.email, // email-as-identity for the owner
    name: spec.ownerName,
    role: "administrator",
    authorizedBranchIds: [branchId],
    passwordHash,
    mustChangePassword: false,
    passwordUpdatedAt: new Date(),
  }).onConflictDoNothing();

  /* The team they listed. They arrive needing a password set — we have no
     business inventing one — but they exist, with the right role, so the
     owner opens on their actual shop rather than an empty one.

     Somebody named without an email cannot sign in, so they are recorded
     but not given an account: a login nobody can reach is worse than an
     absence, because it looks like it works. */
  let staffCreated = 0;
  for (const m of spec.team) {
    if (!m.email || m.email === spec.email) continue;
    const role = ROLE_MAP[m.role] ?? "teller";
    const res = await db.insert(schema.staffUsers).values({
      id: `${tenantId}:${m.email}`,
      tenantId, legalEntityId, branchId,
      staffId: m.email,
      name: m.name,
      role,
      authorizedBranchIds: [branchId],
      passwordHash: "",
      mustChangePassword: true,
      passwordUpdatedAt: null,
    }).onConflictDoNothing();
    void res;
    staffCreated++;
  }

  await audit(db, {
    tenantId, legalEntityId, branchId, actorId: ownerId,
    action: "tenant.created",
    detail: { via, slug, email: spec.email, plan: spec.plan, team: staffCreated },
  });

  return { tenantId, legalEntityId, branchId, ownerId, slug, staffCreated };
}

/* Close the loop on the early-access application this desk came from. This
   is the join that makes the funnel a funnel: without it the control panel
   shows applications and desks as two unrelated lists and can never say
   which application became which desk. Best-effort — a desk is real whether
   or not it started as an application. */
/* Mark the application this desk came from as Open.

   `enquiryId` when the caller knows which application it is — the
   onboarding flow always does, because the code in the link IS the
   application. Matching on the email instead was a real bug: the address
   somebody applies with and the address they put down as the desk owner
   are allowed to differ, and when they did the desk opened while its
   application sat in Invited forever. The funnel then disagreed with the
   customer list, and Open stayed empty however many desks existed.

   The email is still the fallback, for the plain signup route where
   there is no reference to go on. */
export async function closeApplication(
  db: Db,
  match: { enquiryId?: string | null; email: string },
  tenantId: string,
  by: string,
): Promise<void> {
  try {
    const target = match.enquiryId
      ? eq(schema.enquiries.id, match.enquiryId)
      : eq(schema.enquiries.email, match.email);
    await db
      .update(schema.enquiries)
      .set({ status: "accepted", tenantId, decidedAt: new Date(), decidedBy: by })
      .where(
        and(
          target,
          eq(schema.enquiries.kind, "early_access"),
          notInArray(schema.enquiries.status, ["accepted", "declined"]),
        ),
      );
  } catch {
    /* the application record is bookkeeping; never let it fail a signup */
  }
}
