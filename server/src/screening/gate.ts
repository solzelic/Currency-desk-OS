import { randomUUID } from "node:crypto";
import type pg from "pg";
import { bestMatch, type ListEntry } from "./match.js";
import { SCORE_THRESHOLD_PLACEHOLDER, type DobConstraint } from "./names.js";

export const TELLER_HOLD_MESSAGE = "This needs review. A supervisor will help.";

type Row = Record<string, unknown>;
type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>;
};

export type ScreenSubject = {
  name: string;
  dob?: string | null;
  clientId?: string | null;
  customerId?: string | null;
  quoteId?: string | null;
};

type ActorScope = { tenantId: string; legalEntityId: string; userId: string };

type StoredEntry = ListEntry & { sourceKey: string };

export type ScreenPlan = {
  hold: boolean;
  outcome: "clear" | "possible" | "confirmed" | "not_screened";
  hit: { score: number; key: string; name: string; sourceKey: string } | null;
};

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
  entries: readonly StoredEntry[];
  threshold: number;
  subject: { name: string; dob?: string | null };
  confirmed: boolean;
  clearedKeys: readonly string[];
}): ScreenPlan {
  if (input.confirmed) return { hold: true, outcome: "confirmed", hit: null };
  if (!input.entries.length) return { hold: false, outcome: "not_screened", hit: null };
  const found = bestMatch(input.subject, input.entries, input.threshold);
  if (!found) return { hold: false, outcome: "clear", hit: null };
  const hit = {
    score: found.score,
    key: found.entry.key,
    name: found.matchedName,
    sourceKey: (found.entry as StoredEntry).sourceKey,
  };
  if (input.clearedKeys.includes(hit.key)) return { hold: false, outcome: "clear", hit };
  return { hold: true, outcome: "possible", hit };
}

async function threshold(client: Queryable, legalEntityId: string): Promise<number> {
  const found = await client.query(
    "SELECT score_threshold FROM sanctions_score_settings WHERE legal_entity_id = $1",
    [legalEntityId],
  );
  const score = found.rows[0] ? Number(found.rows[0].score_threshold) : SCORE_THRESHOLD_PLACEHOLDER;
  return Number.isFinite(score) && score > 0 && score <= 1 ? score : SCORE_THRESHOLD_PLACEHOLDER;
}

async function entries(client: Queryable): Promise<StoredEntry[]> {
  const found = await client.query(`
    SELECT e.entry_key, e.names, e.dobs, s.source_key
      FROM sanctions_list_entries e
      JOIN sanctions_list_snapshots s ON s.snapshot_id = e.snapshot_id
     WHERE s.status = 'good'
       AND s.snapshot_id IN (
         SELECT DISTINCT ON (source_key) snapshot_id
           FROM sanctions_list_snapshots
          WHERE status = 'good'
          ORDER BY source_key, fetched_at DESC
       )
  `);
  return found.rows.map((row) => ({
    key: String(row.entry_key),
    names: asStrings(row.names),
    dobs: asDobs(row.dobs),
    sourceKey: String(row.source_key),
  }));
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

export async function evaluateSubject(client: Queryable, actor: ActorScope, subject: ScreenSubject): Promise<ScreenPlan> {
  const list = await entries(client);
  const block = await blocking(client, actor, subject);
  const line = await threshold(client, actor.legalEntityId);
  const plan = planScreen({
    entries: list,
    threshold: line,
    subject: { name: subject.name, dob: subject.dob },
    confirmed: block.confirmed,
    clearedKeys: block.clearedKeys,
  });
  if (!plan.hold && await openReview(client, actor, subject)) {
    return { hold: true, outcome: "possible", hit: plan.hit };
  }
  return plan;
}

async function record(client: Queryable, actor: ActorScope, subject: ScreenSubject, plan: ScreenPlan): Promise<string> {
  const screeningId = `scr_${randomUUID()}`;
  await client.query(
    `INSERT INTO sanctions_screenings
      (screening_id, tenant_id, legal_entity_id, client_id, customer_id, quote_id,
       subject_name, subject_dob, outcome, score, matched_entry_key, matched_name, matched_source_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      screeningId, actor.tenantId, actor.legalEntityId, subject.clientId ?? null, subject.customerId ?? null,
      subject.quoteId ?? null, subject.name, dobText(subject.dob), plan.outcome,
      plan.hit ? plan.hit.score : null, plan.hit?.key ?? null, plan.hit?.name ?? null, plan.hit?.sourceKey ?? null,
    ],
  );
  if (plan.hold && plan.outcome !== "confirmed" && !(await openReview(client, actor, subject))) {
    await client.query(
      `INSERT INTO sanctions_reviews
        (review_id, tenant_id, legal_entity_id, client_id, customer_id, quote_id, screening_id,
         subject_name, status, matched_entry_key, matched_name, matched_source_key, score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12)`,
      [
        `rev_${randomUUID()}`, actor.tenantId, actor.legalEntityId, subject.clientId ?? null,
        subject.customerId ?? null, subject.quoteId ?? null, screeningId, subject.name,
        plan.hit?.key ?? null, plan.hit?.name ?? null, plan.hit?.sourceKey ?? null, plan.hit?.score ?? null,
      ],
    );
  }
  if (subject.clientId) {
    await client.query(
      `UPDATE desk_clients
          SET screening_outcome = $2, screening_matched = NULL
        WHERE client_id = $1 AND tenant_id = $3 AND legal_entity_id = $4`,
      [subject.clientId, plan.outcome === "clear" ? "clear" : null, actor.tenantId, actor.legalEntityId],
    );
  }
  return screeningId;
}

export async function screenSubject(client: Queryable, actor: ActorScope, subject: ScreenSubject): Promise<ScreenPlan> {
  const plan = await evaluateSubject(client, actor, subject);
  if (plan.outcome === "not_screened" && !plan.hold) {
    if (subject.clientId) {
      await client.query(
        `UPDATE desk_clients SET screening_outcome = NULL, screening_matched = NULL
          WHERE client_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
        [subject.clientId, actor.tenantId, actor.legalEntityId],
      );
    }
    return plan;
  }
  await record(client, actor, subject, plan);
  return plan;
}

export async function holdForCustomer(
  client: Queryable,
  actor: ActorScope,
  customerId: string,
  quoteId: string,
): Promise<boolean> {
  const found = await client.query(
    `SELECT c.name, c.client_id, d.date_of_birth
       FROM ledger_customers c
       LEFT JOIN desk_clients d ON d.client_id = c.client_id
      WHERE c.customer_id = $1 AND c.tenant_id = $2 AND c.legal_entity_id = $3`,
    [customerId, actor.tenantId, actor.legalEntityId],
  );
  const row = found.rows[0];
  if (!row || typeof row.name !== "string" || !row.name.trim()) return false;
  const plan = await screenSubject(client, actor, {
    name: row.name,
    dob: dobText(row.date_of_birth),
    clientId: row.client_id ? String(row.client_id) : null,
    customerId,
    quoteId,
  });
  return plan.hold;
}

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
