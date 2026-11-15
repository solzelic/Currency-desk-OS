/* Official-list snapshots. A failed fetch inserts a row and sets the
   ops flag. It does not delete entries from the last good snapshot. */
CREATE TABLE IF NOT EXISTS sanctions_list_snapshots (
  snapshot_id text PRIMARY KEY,
  source_key text NOT NULL,
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  last_checked_at timestamptz NOT NULL,
  content_sha256 text NOT NULL,
  entry_count integer NOT NULL,
  status text NOT NULL CHECK (status IN ('writing', 'good', 'failed')),
  error_text text,
  added_count integer NOT NULL DEFAULT 0,
  removed_count integer NOT NULL DEFAULT 0,
  previous_snapshot_id text
);

CREATE INDEX IF NOT EXISTS sanctions_list_snapshots_source_idx
  ON sanctions_list_snapshots (source_key, fetched_at DESC);

CREATE TABLE IF NOT EXISTS sanctions_list_entries (
  snapshot_id text NOT NULL REFERENCES sanctions_list_snapshots(snapshot_id),
  entry_key text NOT NULL,
  names jsonb NOT NULL,
  dobs jsonb NOT NULL,
  PRIMARY KEY (snapshot_id, entry_key)
);

/* One current alert per source. A good fetch clears it. A failed fetch
   sets it. The previous entries stay. */
CREATE TABLE IF NOT EXISTS sanctions_ops_flags (
  source_key text PRIMARY KEY,
  alert boolean NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL
);

/* Placeholder threshold. signed_off stays false until a Compliance
   Officer records sign-off. The default in code is the same placeholder. */
CREATE TABLE IF NOT EXISTS sanctions_score_settings (
  legal_entity_id text PRIMARY KEY,
  score_threshold numeric NOT NULL,
  signed_off boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sanctions_score_threshold_range CHECK (score_threshold > 0 AND score_threshold <= 1)
);
