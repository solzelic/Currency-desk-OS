/* ============================================================
   What is actually inside a desk's saved state.

   THE PROBLEM THIS SOLVES

   The document was validated as `z.record(z.unknown())` — a schema that
   accepts everything and therefore verifies nothing. Forty-four different
   keys are written into it by fifteen files, and until now nothing on the
   server knew the name of a single one. Drift was not merely undetected;
   it was undetectable.

   That matters more than it used to. Code written with an assistant
   compiles against `unknown` just as happily as code written by hand, so a
   key that changed shape three releases ago produces no error anywhere and
   surfaces when a customer notices. A schema at the boundary is the only
   thing that turns that into a fact somebody can read.

   WHY THIS DESCRIBES AND DOES NOT REFUSE

   The obvious move is to reject a document that fails validation. It would
   be wrong here, and dangerously so.

   The browser is the ONLY copy of this data. Refusing a malformed save does
   not protect the desk — it destroys the thing it was trying to protect,
   and it destroys it silently, which is precisely the bug fixed in
   src/state/contract.ts. A validator that turns "this field looks odd" into
   "this shop lost today's clients" is worse than no validator.

   So: every save is accepted, and every save is described. What we learn is
   what the shapes really are, which desks are drifting, and — most useful —
   how much of the document is compliance-bearing rather than screen
   furniture. Once the reports are clean, individual keys can be tightened
   from "described" to "enforced" one at a time, on evidence.

   Genuinely dangerous content is a separate matter and is stripped rather
   than described — see absorbStaffPins in routes/tenantState.ts, which
   moves a till PIN out of a document the browser downloads whole.

   THE CATALOGUE IS THE ROADMAP

   Every key is marked `record` or `preference`, and that single field is
   the plan from docs/ARCHITECTURE.md §3 made executable:

     record      something a regulator, an auditor or a court could ask
                 about. Belongs in a table. Currently in a document.
     preference  only this screen cares. A document is the right shape and
                 it can stay here forever.

   `recordBytes` in the report below is therefore the size of the problem,
   and watching it fall is how we will know the promotion work is done.
   ============================================================ */
import { z } from "zod";

export type Kind = "record" | "preference";

export interface KeyShape {
  /** The localStorage key, verbatim. */
  key: string;
  kind: Kind;
  /** Plain English, for whoever reads a report and was not here. */
  what: string;
  /** The shape of the PARSED value. Absent where we have not pinned it down
      yet — the key is still catalogued, sized and classified. */
  schema?: z.ZodTypeAny;
  /** Where this is headed, for `record` keys. */
  promoteTo?: string;
}

/* ---- the shapes we have pinned down ----------------------------------

   Deliberately loose about extra fields. These are describing something
   that already exists and is still moving; a schema that fails on an
   unexpected field would report drift on every release and teach everyone
   to ignore it. What is asserted here is the fields we depend on. */

const money = z.union([z.number(), z.string()]);

/* A customer of the desk. Keyed by NAME, which is the flaw that makes
   promotion urgent rather than tidy: two people called David Chen are one
   client, and correcting a spelling orphans a transaction history. The id
   arrives with the identity work; the schema records the fact meanwhile. */
export const clientShape = z
  .object({
    kind: z.enum(["individual", "corporate"]).optional(),
    idType: z.string().optional(),
    idNum: z.string().optional(),
    idExpiry: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    dob: z.string().optional(),
    occupation: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    province: z.string().optional(),
    postal: z.string().optional(),
    risk: z.string().optional(),
    notes: z.string().optional(),
    // corporate
    incorpDate: z.string().optional(),
    jurisdiction: z.string().optional(),
    business: z.string().optional(),
    contactName: z.string().optional(),
    contactTitle: z.string().optional(),
  })
  .passthrough();

/* A line in the desk's book. `serverTransactionId` is present when the row
   came from the real ledger — the two records of one transaction that §3 of
   the architecture is about. */
export const rowShape = z
  .object({
    id: z.union([z.string(), z.number()]),
    ref: z.string().optional(),
    date: z.string().optional(),
    customer: z.string().optional(),
    inCcy: z.string().optional(),
    inAmt: money.optional(),
    outCcy: z.string().optional(),
    outAmt: money.optional(),
    fee: money.optional(),
    status: z.string().optional(),
    teller: z.string().optional(),
    filed: z.boolean().optional(),
    serverTransactionId: z.string().nullish(),
  })
  .passthrough();

const listOf = (item: z.ZodTypeAny) => z.array(item);

/* ---- the catalogue ---------------------------------------------------- */

export const CATALOGUE: readonly KeyShape[] = [
  /* ---- compliance-bearing. These are why the promotion work exists. ---- */
  { key: "cdos_clients_v1", kind: "record", what: "Customers and their KYC — ID type and number, expiry, address, date of birth, risk rating", schema: z.record(clientShape), promoteTo: "desk_clients" },
  { key: "cdos_rows_v1", kind: "record", what: "The desk's book — every transaction, including ones already in the ledger", schema: listOf(rowShape), promoteTo: "desk_transactions" },
  { key: "cdos_kyc_v1", kind: "record", what: "KYC checks and their evidence" },
  { key: "cdos_submissions_v1", kind: "record", what: "Regulatory filings — LCTR and STR submissions" },
  { key: "cdos_receipts_v1", kind: "record", what: "Receipts issued to customers" },
  { key: "cdos_beneficiaries_v1", kind: "record", what: "Who money was sent to — the other half of a remittance record" },
  { key: "cdos_till_history_v2", kind: "record", what: "Till counts and closes — the reconciliation evidence", promoteTo: "desk_till_counts" },
  { key: "cdos_till_counts", kind: "record", what: "The count in progress" },
  { key: "cdos_till_handoffs_v1", kind: "record", what: "Cash handed from one operator to another" },
  { key: "cdos_till_lastcount_v1", kind: "record", what: "When the till was last counted, and by whom" },
  { key: "cdos_till_counted_at", kind: "record", what: "Timestamp of the last count" },
  { key: "cdos_vault_shifts", kind: "record", what: "Cash moved in and out of the vault" },
  { key: "cdos_branch_moves_v2", kind: "record", what: "Cash moved between branches" },
  { key: "cdos_settlements_v1", kind: "record", what: "Settlements with counterparties" },
  { key: "cdos_transfers_v1", kind: "record", what: "Outbound transfers" },
  { key: "cdos_cheques_v1", kind: "record", what: "Cheques taken in" },
  { key: "cdos_cheque_schedule_v1", kind: "record", what: "When cheques are expected to clear" },
  { key: "cdos_baseline_v1", kind: "record", what: "Opening cash position the day is measured against" },
  { key: "cdos_locked_book", kind: "record", what: "The published rate book a trade was priced against" },
  { key: "cdos_day", kind: "record", what: "The trading day — whether it is open, and when it closed" },
  { key: "cdos_report_history_v1", kind: "record", what: "Reports produced, and by whom" },
  { key: "cdos_report_access_v1", kind: "record", what: "Who opened a sealed report" },
  { key: "cdos_roster_v2", kind: "record", what: "Staff on the desk and their roles" },
  { key: "cdos_perms", kind: "record", what: "What each role may do at this desk" },
  { key: "cdos_stations_v2", kind: "record", what: "Tills and the branches they belong to" },
  { key: "cdos_tg_log_v2", kind: "record", what: "Messages sent to customers" },
  { key: "cdos_tg_contacts_v2", kind: "record", what: "Customer contact details for messaging" },
  { key: "cdos_tg_requests_v2", kind: "record", what: "Rate requests customers sent in" },
  { key: "cdos_tg_broadcasts_v1", kind: "record", what: "Rate broadcasts sent out — who was told what, and when" },
  { key: "cdos_tg_sites_v2", kind: "record", what: "Where broadcasts are published" },
  { key: "cdos_settings", kind: "record", what: "The desk's configuration — name, branches, currencies, thresholds, billing plan" },

  /* ---- only the screen cares. These may stay in a document forever. ---- */
  { key: "cdos_app_order", kind: "preference", what: "The order apps appear in" },
  { key: "cdos_app_hidden", kind: "preference", what: "Apps hidden from the bar" },
  { key: "cdos_theme", kind: "preference", what: "Light or dark" },
  { key: "cdos_calc_v1", kind: "preference", what: "The calculator's last state" },
  { key: "cdos_ticker", kind: "preference", what: "Whether the rate ticker is running" },
  { key: "cdos_station_v1", kind: "preference", what: "Which till this browser is sitting at" },
  { key: "cdos_till_mode", kind: "preference", what: "How the till screen is laid out" },
  { key: "cdos_till_quick", kind: "preference", what: "Quick-count shortcuts" },
  { key: "cdos_till_strip_open", kind: "preference", what: "Whether the till strip is expanded" },
  { key: "cdos_till_operator_v1", kind: "preference", what: "Who this browser last signed in as at the till" },
  { key: "cdos_import_cfg_v1", kind: "preference", what: "Column mapping remembered from the last import" },
  { key: "cdos_corridors_v1", kind: "preference", what: "Remittance corridors shown on screen" },
  { key: "cdos_tg_settings_v1", kind: "preference", what: "Messaging preferences" },
  { key: "cdos_kyc_provider", kind: "preference", what: "Which KYC provider is selected" },
  { key: "cdos_kyc_partner_rate", kind: "preference", what: "The partner rate shown for KYC checks" },
  { key: "yorkfx_rates_v1", kind: "preference", what: "The rate board on screen — the priced record is cdos_locked_book" },
  { key: "yorkfx_rates_locked", kind: "preference", what: "Whether the board is held" },
  { key: "yorkfx_board_order", kind: "preference", what: "Currency order on the board" },
  { key: "yorkfx_rate_provider", kind: "preference", what: "Which rate source is selected" },

  /* Markers saying "this desk has already been given its demonstration
     data", so a reload does not seed it twice. They carry no record of
     anything and are the first things that should stop being saved to the
     server at all — a flag about the browser has no business in a document
     we back up. Catalogued rather than ignored, because the point of the
     catalogue is that nothing in here is a mystery. */
  { key: "cdos_kyc_seed_v3", kind: "preference", what: "Marker: the KYC demonstration data has been seeded" },
  { key: "cdos_report_history_seed_v3", kind: "preference", what: "Marker: the report history demonstration data has been seeded" },
] as const;

const BY_KEY = new Map(CATALOGUE.map((k) => [k.key, k]));

/* ---- the report ------------------------------------------------------- */

export interface KeyReport {
  key: string;
  bytes: number;
  known: boolean;
  kind: Kind | null;
  /** null when there is no schema for this key yet — not a pass and not a
      failure, which is a distinction worth keeping in the numbers. */
  valid: boolean | null;
  issue?: string;
}

export interface StateReport {
  totalBytes: number;
  /** How much of this document is compliance-bearing. The size of the
      problem: promotion is finished when this reaches zero. */
  recordBytes: number;
  preferenceBytes: number;
  /** Sized, so a desk that is getting large can be looked at rather than
      guessed about. Biggest first. */
  keys: KeyReport[];
  /** Keys nothing on the server has ever heard of. Either the OS grew one
      and this catalogue was not updated, or something is writing junk into
      a document we back up and restore. Both are worth knowing. */
  unknown: string[];
  /** Keys whose parsed value did not match the shape we expect. */
  invalid: string[];
}

/** Describe a desk's saved state. Never throws — a report is worthless if
    producing it can take down the save it was meant to observe. */
export function describe(state: Record<string, unknown>): StateReport {
  const keys: KeyReport[] = [];
  const unknown: string[] = [];
  const invalid: string[] = [];
  let recordBytes = 0;
  let preferenceBytes = 0;

  for (const [key, raw] of Object.entries(state ?? {})) {
    const bytes = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw ?? ""));
    const known = BY_KEY.get(key);
    if (!known) unknown.push(key);
    if (known?.kind === "record") recordBytes += bytes;
    else if (known?.kind === "preference") preferenceBytes += bytes;

    let valid: boolean | null = null;
    let issue: string | undefined;
    if (known?.schema) {
      /* Values arrive as JSON strings, because that is how localStorage
         holds them. A value that will not parse is itself the finding. */
      let parsed: unknown;
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        valid = false;
        issue = "not valid JSON";
      }
      if (valid === null) {
        const result = known.schema.safeParse(parsed);
        valid = result.success;
        if (!result.success) issue = result.error.issues[0]?.message ?? "did not match";
      }
      if (valid === false) invalid.push(key);
    }
    keys.push({ key, bytes, known: !!known, kind: known?.kind ?? null, valid, ...(issue ? { issue } : {}) });
  }

  keys.sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes: keys.reduce((n, k) => n + k.bytes, 0),
    recordBytes,
    preferenceBytes,
    keys,
    unknown,
    invalid,
  };
}

/** The one-line version, for a log that runs on every save. */
export function summarise(r: StateReport): string {
  const kb = (n: number) => Math.round(n / 1024);
  return (
    `${kb(r.totalBytes)}KB (${kb(r.recordBytes)}KB record, ${kb(r.preferenceBytes)}KB preference)` +
    (r.unknown.length ? `, ${r.unknown.length} unknown: ${r.unknown.slice(0, 5).join(", ")}` : "") +
    (r.invalid.length ? `, ${r.invalid.length} not matching shape: ${r.invalid.slice(0, 5).join(", ")}` : "")
  );
}
