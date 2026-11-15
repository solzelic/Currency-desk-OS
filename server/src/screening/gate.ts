import { randomUUID } from "node:crypto";
import type pg from "pg";
import { matchesAbove, type ListEntry } from "./match.js";
import { SCORE_THRESHOLD_PLACEHOLDER, type DobConstraint } from "./names.js";
import { LIST_SOURCES } from "./sources.js";

export const TELLER_HOLD_MESSAGE = "This needs review. Your compliance officer will review this.";

export const NAME_OFFICER_MESSAGE = "Name your compliance officer. Every MSB must have one.";

type Row = Record<string, unknown>;
type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>;
};

export type ScreenSubject = {
  name: string;
  aliases?: string[];
  /** No usable customer name. The deal is held and a review is opened. */
  unnamed?: boolean;
  dob?: string | null;
  clientId?: string | null;
  customerId?: string | null;
  quoteId?: string | null;
};

type ActorScope = { tenantId: string; legalEntityId: string; userId: string };

type StoredEntry = ListEntry & { sourceKey: string; snapshotId: string; contentSha256: string };

export type ListSnapshotRef = { snapshotId: string; contentSha256: string; sourceKey: string };

export type ScreenHit = { score: number; key: string; name: string; sourceKey: string };

export type ScreenPlan = {
  hold: boolean;
  outcome: "clear" | "possible" | "confirmed" | "not_screened";
  hit: ScreenHit | null;
  hits: ScreenHit[];
  lists: ListSnapshotRef[];
};

const REQUIRED_LISTS = LIST_SOURCES.map((source) => source.key);

function emptyPlan(outcome: ScreenPlan["outcome"], hold: boolean, lists: ListSnapshotRef[] = []): ScreenPlan {
  return { hold, outcome, hit: null, hits: [], lists };
}

function dobText(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${value.getUTCFullYear()}-${month}-${day}`;
  }
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asDobs(value: unknown): DobConstraint[] {
  const raw = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const kind = (item as { kind?: unknown }).kind;
    const stored = (item as { value?: unknown }).value;
    if ((kind === "date" || kind === "month" || kind === "year") && typeof stored === "string") {
      return [{ kind, value: stored }];
    }
    return [];
  });
}

export function planScreen(input: {
  entries: readonly (ListEntry & { sourceKey: string })[];
  threshold: number;
  subject: { name: string; aliases?: readonly string[]; dob?: string | null };
  confirmed: boolean;
  clearedKeys: readonly string[];
  lists?: readonly ListSnapshotRef[];
}): ScreenPlan {
  const lists = [...(input.lists ?? [])];
  if (input.confirmed) return { hold: true, outcome: "confirmed", hit: null, hits: [], lists };
  if (!input.entries.length) return emptyPlan("not_screened", false, lists);
  const found = matchesAbove(input.subject, input.entries, input.threshold);
  const hits = found
    .filter((item) => !input.clearedKeys.includes(item.entry.key))
    .map((item) => ({
      score: item.score,
      key: item.entry.key,
      name: item.matchedName,
      sourceKey: (item.entry as StoredEntry).sourceKey,
    }));
  if (!hits.length) return emptyPlan("clear", false, lists);
  return { hold: true, outcome: "possible", hit: hits[0] ?? null, hits, lists };
}

async function scoreSetting(client: Queryable, legalEntityId: string): Promise<{ score: number; signedOff: boolean }> {
  const found = await client.query(
    "SELECT score_threshold, signed_off FROM sanctions_score_settings WHERE legal_entity_id = $1",
    [legalEntityId],
  );
  const score = found.rows[0] ? Number(found.rows[0].score_threshold) : SCORE_THRESHOLD_PLACEHOLDER;
  return {
    score: Number.isFinite(score) && score > 0 && score <= 1 ? score : SCORE_THRESHOLD_PLACEHOLDER,
    signedOff: found.rows[0]?.signed_off === true,
  };
}

async function freshLists(client: Queryable): Promise<{ entries: StoredEntry[]; lists: ListSnapshotRef[]; complete: boolean }> {
  const snaps = await client.query(`
    SELECT source_key, snapshot_id, content_sha256
      FROM (
        SELECT DISTINCT ON (source_key) source_key, snapshot_id, content_sha256, last_checked_at
          FROM sanctions_list_snapshots
         WHERE status = 'good'
         ORDER BY source_key, fetched_at DESC
      ) latest
     WHERE last_checked_at >= now() - interval '24 hours'
  `);
  const lists: ListSnapshotRef[] = snaps.rows.map((row) => ({
    snapshotId: String(row.snapshot_id),
    contentSha256: String(row.content_sha256),
    sourceKey: String(row.source_key),
  }));
  const ids = lists.map((item) => item.snapshotId);
  const found = ids.length
    ? await client.query(
      `SELECT e.entry_key, e.names, e.dobs, s.source_key, s.snapshot_id, s.content_sha256
         FROM sanctions_list_entries e
         JOIN sanctions_list_snapshots s ON s.snapshot_id = e.snapshot_id
        WHERE s.snapshot_id = ANY($1::text[])`,
      [ids],
    )
    : { rows: [] as Row[] };
  return {
    entries: found.rows.map((row) => ({
      key: String(row.entry_key),
      names: asStrings(row.names),
      dobs: asDobs(row.dobs),
      sourceKey: String(row.source_key),
      snapshotId: String(row.snapshot_id),
      contentSha256: String(row.content_sha256),
    })),
    lists,
    complete: REQUIRED_LISTS.every((key) => lists.some((item) => item.sourceKey === key)),
  };
}

async function blocking(client: Queryable, actor: ActorScope, subject: ScreenSubject): Promise<{ confirmed: boolean; clearedKeys: string[] }> {
  const found = await client.query(
    `SELECT status, matched_entry_key
       FROM sanctions_reviews
      WHERE tenant_id = $1 AND legal_entity_id = $2
        AND (
          ($3::text IS NOT NULL AND client_id = $3)
          OR ($4::text IS NOT NULL AND customer_id = $4)
        )`,
    [actor.tenantId, actor.legalEntityId, subject.clientId ?? null, subject.customerId ?? null],
  );
  const clearedKeys = found.rows
    .filter((row) => row.status === "cleared" && row.matched_entry_key)
    .map((row) => String(row.matched_entry_key));
  return { confirmed: found.rows.some((row) => row.status === "confirmed"), clearedKeys };
}

async function openReview(client: Queryable, actor: ActorScope, subject: ScreenSubject): Promise<boolean> {
  const found = await client.query(
    `SELECT 1 FROM sanctions_reviews
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'open'
        AND (
          ($3::text IS NOT NULL AND client_id = $3)
          OR ($4::text IS NOT NULL AND customer_id = $4)
        )
      LIMIT 1`,
    [actor.tenantId, actor.legalEntityId, subject.clientId ?? null, subject.customerId ?? null],
  );
  return (found.rowCount ?? found.rows.length) > 0;
}

/** Test seam. The same process sets this so a failed screen still opens a review. */
function forcedScreenFailure(): boolean {
  return (globalThis as { __cdScreeningFail?: boolean }).__cdScreeningFail === true;
}

export async function evaluateSubject(client: Queryable, actor: ActorScope, subject: ScreenSubject): Promise<ScreenPlan> {
  if (forcedScreenFailure()) throw new Error("screen failed");
  const coverage = await freshLists(client);
  const block = await blocking(client, actor, subject);
  const setting = await scoreSetting(client, actor.legalEntityId);
  let plan = planScreen({
    entries: coverage.entries,
    threshold: setting.score,
    subject: { name: subject.name, aliases: subject.aliases, dob: subject.dob },
    confirmed: block.confirmed,
    clearedKeys: block.clearedKeys,
    lists: coverage.lists,
  });
  if (!plan.hold && await openReview(client, actor, subject)) {
    plan = { ...plan, hold: true, outcome: "possible" };
  }
  /* A match still holds. Anything else is not a clearance until the score
     is signed off and every required list is fresh. */
  if (!plan.hold && plan.outcome === "clear" && (!setting.signedOff || !coverage.complete)) {
    plan = { ...plan, outcome: "not_screened" };
  }
  if (!setting.signedOff && plan.outcome === "clear") {
    plan = { ...plan, outcome: "not_screened" };
  }
  return plan;
}

async function record(client: Queryable, actor: ActorScope, subject: ScreenSubject, plan: ScreenPlan): Promise<string> {
  const screeningId = `scr_${randomUUID()}`;
  await client.query(
    `INSERT INTO sanctions_screenings
      (screening_id, tenant_id, legal_entity_id, client_id, customer_id, quote_id,
       subject_name, subject_dob, outcome, score, matched_entry_key, matched_name, matched_source_key, list_snapshots)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      screeningId, actor.tenantId, actor.legalEntityId, subject.clientId ?? null, subject.customerId ?? null,
      subject.quoteId ?? null, subject.name, dobText(subject.dob), plan.outcome,
      plan.hit ? plan.hit.score : null, plan.hit?.key ?? null, plan.hit?.name ?? null, plan.hit?.sourceKey ?? null,
      JSON.stringify(plan.lists),
    ],
  );
  if (plan.hold && plan.outcome !== "confirmed") {
    const hits = plan.hits.length ? plan.hits : [null];
    for (const hit of hits) {
      if (hit) {
        const existing = await client.query(
          `SELECT 1 FROM sanctions_reviews
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'open'
              AND matched_entry_key = $3
              AND (
                ($4::text IS NOT NULL AND client_id = $4)
                OR ($5::text IS NOT NULL AND customer_id = $5)
              )
            LIMIT 1`,
          [actor.tenantId, actor.legalEntityId, hit.key, subject.clientId ?? null, subject.customerId ?? null],
        );
        if ((existing.rowCount ?? existing.rows.length) > 0) continue;
      } else if (await openReview(client, actor, subject)) {
        continue;
      }
      await client.query(
        `INSERT INTO sanctions_reviews
          (review_id, tenant_id, legal_entity_id, client_id, customer_id, quote_id, screening_id,
           subject_name, status, matched_entry_key, matched_name, matched_source_key, score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12)`,
        [
          `rev_${randomUUID()}`, actor.tenantId, actor.legalEntityId, subject.clientId ?? null,
          subject.customerId ?? null, subject.quoteId ?? null, screeningId, subject.name,
          hit?.key ?? null, hit?.name ?? null, hit?.sourceKey ?? null, hit?.score ?? null,
        ],
      );
    }
  }
  if (subject.clientId) {
    await client.query(
      `UPDATE desk_clients
          SET screening_outcome = $2, screening_matched = NULL
        WHERE client_id = $1 AND tenant_id = $3 AND legal_entity_id = $4`,
      [subject.clientId, clientScreening(plan.outcome), actor.tenantId, actor.legalEntityId],
    );
  }
  return screeningId;
}

function clientScreening(outcome: ScreenPlan["outcome"]): string {
  if (outcome === "clear") return "clear";
  if (outcome === "possible") return "possible";
  if (outcome === "confirmed") return "confirmed";
  return "not_screened";
}

async function recordFailure(client: Queryable, actor: ActorScope, subject: ScreenSubject): Promise<void> {
  await record(client, actor, subject, {
    hold: true,
    outcome: "possible",
    hit: null,
    hits: [],
    lists: [],
  });
}

export async function screenSubject(client: Queryable, actor: ActorScope, subject: ScreenSubject): Promise<ScreenPlan> {
  await client.query("SAVEPOINT sanctions_screen");
  try {
    if (subject.unnamed) {
      const plan = emptyPlan("possible", true);
      await record(client, actor, subject, plan);
      await client.query("RELEASE SAVEPOINT sanctions_screen");
      return plan;
    }
    const plan = await evaluateSubject(client, actor, subject);
    await record(client, actor, subject, plan);
    await client.query("RELEASE SAVEPOINT sanctions_screen");
    return plan;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT sanctions_screen");
    try {
      await recordFailure(client, actor, subject);
      await client.query("RELEASE SAVEPOINT sanctions_screen");
    } catch (inner) {
      throw inner instanceof Error ? inner : err;
    }
    return emptyPlan("possible", true);
  }
}

export async function holdForCustomer(
  client: Queryable,
  actor: ActorScope,
  customerId: string,
  quoteId: string | null,
): Promise<ScreenPlan> {
  const found = await client.query(
    `SELECT c.name, c.client_id, d.date_of_birth
       FROM ledger_customers c
       LEFT JOIN desk_clients d ON d.client_id = c.client_id
      WHERE c.customer_id = $1 AND c.tenant_id = $2 AND c.legal_entity_id = $3`,
    [customerId, actor.tenantId, actor.legalEntityId],
  );
  const row = found.rows[0];
  const name = row && typeof row.name === "string" ? row.name.trim() : "";
  if (!row || !name) {
    return screenSubject(client, actor, {
      name: "Unnamed customer",
      unnamed: true,
      customerId,
      quoteId,
      clientId: row?.client_id ? String(row.client_id) : null,
    });
  }
  const aliases = row.client_id
    ? await client.query(
      "SELECT alias FROM desk_client_aliases WHERE client_id = $1",
      [row.client_id],
    )
    : { rows: [] as Row[] };
  return screenSubject(client, actor, {
    name,
    aliases: aliases.rows.map((item) => String(item.alias)),
    dob: dobText(row.date_of_birth),
    clientId: row.client_id ? String(row.client_id) : null,
    customerId,
    quoteId,
  });
}

/** Only the shop's named compliance officer may decide. Nobody may when none is named.
    A teller never may, even if that column names them. */
export function mayReviewScreening(role: string, staffId: string, namedStaffId: string | null): boolean {
  if (!namedStaffId) return false;
  if (role === "teller" || role === "supervisor" || role === "auditor" || role === "branch_manager") return false;
  return namedStaffId === staffId && (role === "administrator" || role === "compliance_officer");
}

export async function guardCustomerMoney(
  pool: pg.Pool,
  actor: ActorScope,
  customerId: string,
): Promise<ScreenPlan> {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    const plan = await holdForCustomer(client, actor, customerId, null);
    await client.query("COMMIT");
    client.release();
    released = true;
    return plan;
  } catch (err) {
    if (!released) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (!released) client.release();
  }
}

export const LPEPR_TASK = "File a listed person or entity property report (LPEPR) with FINTRAC without delay, and disclose to the RCMP and CSIS.";

export async function rescreenAll(pool: pg.Pool): Promise<number> {
  const clients = await pool.query(
    `SELECT client_id, tenant_id, legal_entity_id, display_name, date_of_birth, created_by
       FROM desk_clients`,
  );
  let held = 0;
  for (const row of clients.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const plan = await screenSubject(client, {
        tenantId: String(row.tenant_id),
        legalEntityId: String(row.legal_entity_id),
        userId: String(row.created_by ?? "system"),
      }, {
        name: String(row.display_name),
        dob: dobText(row.date_of_birth),
        clientId: String(row.client_id),
      });
      await client.query("COMMIT");
      if (plan.hold) held += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return held;
}

export function pgPool(db: unknown): pg.Pool | null {
  const client = (db as { session?: { client?: pg.Pool } }).session?.client;
  if (client && typeof client.connect === "function") return client;
  return null;
}
