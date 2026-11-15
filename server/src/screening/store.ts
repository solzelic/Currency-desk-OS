import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DobConstraint } from "./names.js";
import { SCORE_THRESHOLD_PLACEHOLDER } from "./names.js";
import { diffKeys, type ListEntry } from "./match.js";

export type SqlDb = {
  execute: (query: ReturnType<typeof sql>) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
};

export type GoodSnapshot = {
  snapshotId: string;
  hash: string;
  keys: string[];
};

export function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function latestGood(db: SqlDb, sourceKey: string): Promise<GoodSnapshot | null> {
  const found = await db.execute(sql`
    SELECT snapshot_id, content_sha256
      FROM sanctions_list_snapshots
     WHERE source_key = ${sourceKey} AND status = 'good'
     ORDER BY fetched_at DESC
     LIMIT 1
  `);
  const row = found.rows[0];
  if (!row) return null;
  const snapshotId = String(row.snapshot_id);
  const keys = await db.execute(sql`
    SELECT entry_key FROM sanctions_list_entries WHERE snapshot_id = ${snapshotId}
  `);
  return {
    snapshotId,
    hash: String(row.content_sha256),
    keys: keys.rows.map((item) => String(item.entry_key)),
  };
}

async function setAlert(db: SqlDb, sourceKey: string, alert: boolean, reason: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO sanctions_ops_flags (source_key, alert, reason, updated_at)
    VALUES (${sourceKey}, ${alert}, ${reason}, now())
    ON CONFLICT (source_key) DO UPDATE
      SET alert = EXCLUDED.alert, reason = EXCLUDED.reason, updated_at = now()
  `);
}

export async function markUnchanged(db: SqlDb, snapshotId: string, sourceKey: string): Promise<void> {
  await db.execute(sql`
    UPDATE sanctions_list_snapshots
       SET last_checked_at = now()
     WHERE snapshot_id = ${snapshotId}
  `);
  await setAlert(db, sourceKey, false, null);
}

export async function storeGood(
  db: SqlDb,
  source: { key: string; url: string },
  body: string,
  entries: ListEntry[],
  previous: GoodSnapshot | null,
): Promise<{ snapshotId: string; added: number; removed: number }> {
  const hash = sha256(body);
  const diff = diffKeys(previous?.keys ?? [], entries.map((entry) => entry.key));
  const snapshotId = `snp_${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO sanctions_list_snapshots
      (snapshot_id, source_key, source_url, fetched_at, last_checked_at, content_sha256,
       entry_count, status, added_count, removed_count, previous_snapshot_id)
    VALUES
      (${snapshotId}, ${source.key}, ${source.url}, now(), now(), ${hash},
       ${entries.length}, 'good', ${diff.added.length}, ${diff.removed.length}, ${previous?.snapshotId ?? null})
  `);
  const size = 80;
  for (let i = 0; i < entries.length; i += size) {
    const chunk = entries.slice(i, i + size);
    const values = chunk.map((entry) => sql`(
      ${snapshotId}, ${entry.key}, ${JSON.stringify(entry.names)}::jsonb, ${JSON.stringify(entry.dobs)}::jsonb
    )`);
    await db.execute(sql`
      INSERT INTO sanctions_list_entries (snapshot_id, entry_key, names, dobs)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }
  await setAlert(db, source.key, false, null);
  return { snapshotId, added: diff.added.length, removed: diff.removed.length };
}

/** A failed fetch records the alert and leaves every previous entry in place. */
export async function storeFailed(
  db: SqlDb,
  source: { key: string; url: string },
  reason: string,
  previous: GoodSnapshot | null,
): Promise<void> {
  const snapshotId = `snp_${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO sanctions_list_snapshots
      (snapshot_id, source_key, source_url, fetched_at, last_checked_at, content_sha256,
       entry_count, status, error_text, previous_snapshot_id)
    VALUES
      (${snapshotId}, ${source.key}, ${source.url}, now(), now(), ${"failed"},
       ${previous?.keys.length ?? 0}, 'failed', ${reason.slice(0, 500)}, ${previous?.snapshotId ?? null})
  `);
  await setAlert(db, source.key, true, reason.slice(0, 500));
}

export async function loadGoodEntries(db: SqlDb): Promise<ListEntry[]> {
  const found = await db.execute(sql`
    SELECT e.entry_key, e.names, e.dobs
      FROM sanctions_list_entries e
      JOIN sanctions_list_snapshots s ON s.snapshot_id = e.snapshot_id
     WHERE s.status = 'good'
       AND s.fetched_at = (
         SELECT max(g.fetched_at) FROM sanctions_list_snapshots g
          WHERE g.source_key = s.source_key AND g.status = 'good'
       )
  `);
  return found.rows.map((row) => ({
    key: String(row.entry_key),
    names: asStrings(row.names),
    dobs: asDobs(row.dobs),
  }));
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
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

export async function thresholdFor(db: SqlDb, legalEntityId: string): Promise<{ score: number; signedOff: false | true; note: string }> {
  const found = await db.execute(sql`
    SELECT score_threshold, signed_off
      FROM sanctions_score_settings
     WHERE legal_entity_id = ${legalEntityId}
     LIMIT 1
  `);
  const row = found.rows[0];
  const score = row ? Number(row.score_threshold) : SCORE_THRESHOLD_PLACEHOLDER;
  const signedOff = row ? row.signed_off === true : false;
  return {
    score: Number.isFinite(score) ? score : SCORE_THRESHOLD_PLACEHOLDER,
    signedOff,
    note: signedOff ? "signed off" : "placeholder pending Compliance Officer sign-off",
  };
}
