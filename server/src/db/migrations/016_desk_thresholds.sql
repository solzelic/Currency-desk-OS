/* ============================================================
   The pack proposes, the desk decides.

   A jurisdiction pack states what the regulator requires: report a cash
   deal at or above 10,000 in Canada, identify the customer at or above
   3,000, keep the paperwork five years. Those are the country's numbers
   and this desk does not get to raise them.

   It does get to lower them. A desk whose bank or whose auditor wants to
   see more diligence sets its identification line at 1,000 and reports at
   7,500, and that is a legitimate business decision made by the person
   who answers for the shop — not a fault, not a warning, and not
   something the code should argue with. What it may never do is set a
   line ABOVE the mandate, because that is the desk quietly deciding not
   to report things it is legally obliged to report.

   So the same shape as `legal_entities.cost_method` (migration 014):

     jurisdiction_packs.*    what the regulator requires
     legal_entities.*        what this desk actually operates at

   and NULL on the entity is not a missing value. It means "follow the
   pack", which is where every desk starts and where it stays until
   somebody deliberately decides otherwise. See
   docs/DESK_THRESHOLDS.md and server/src/ledger/thresholds.ts.

   ---- why the packs grow two columns here ----

   The packs already carry the two money lines. They did not carry the
   aggregation window or the retention period, and the browser was
   judging a desk's choice of both against a two-entry table of its own —
   which held FINTRAC and FinCEN and nothing else, so a desk in Dubai was
   measured against Canada's rules or against nothing at all. A mandate
   the code cannot state is a mandate the code cannot enforce, so the
   pack states it.

   The values below are each jurisdiction's actual requirement.
   Australia's seven years is the one that differs, and it is the reason
   this cannot be a constant either.
   ============================================================ */

/* ---- what the regulator requires ---- */

/* The window over which several small cash deals by the same person are
   summed against the reporting line. Every regulator shipped here uses
   twenty-four hours; it is a column rather than a constant because the
   next one might not, and because a desk running a LONGER window — which
   catches more, not less — has to be told it is doing more than required
   rather than being flagged for it. */
ALTER TABLE jurisdiction_packs
  ADD COLUMN IF NOT EXISTS aggregation_hours integer NOT NULL DEFAULT 24;

/* How long filed reports and the records behind them must be kept. */
ALTER TABLE jurisdiction_packs
  ADD COLUMN IF NOT EXISTS retention_years integer NOT NULL DEFAULT 5;

ALTER TABLE jurisdiction_packs
  DROP CONSTRAINT IF EXISTS jurisdiction_packs_aggregation_hours_check;
ALTER TABLE jurisdiction_packs
  ADD CONSTRAINT jurisdiction_packs_aggregation_hours_check
    CHECK (aggregation_hours > 0 AND aggregation_hours <= 24 * 31);

ALTER TABLE jurisdiction_packs
  DROP CONSTRAINT IF EXISTS jurisdiction_packs_retention_years_check;
ALTER TABLE jurisdiction_packs
  ADD CONSTRAINT jurisdiction_packs_retention_years_check
    CHECK (retention_years > 0 AND retention_years <= 100);

/* AUSTRAC requires seven years; every other pack shipped today requires
   five. Stated per pack rather than left on the default so that the row
   reads as a decision somebody made about that country. */
UPDATE jurisdiction_packs SET retention_years = 7 WHERE pack_id = 'pack-au-v1';
UPDATE jurisdiction_packs SET retention_years = 5
 WHERE pack_id IN ('pack-ca-v1','pack-us-v1','pack-gb-v1','pack-eu-v1','pack-ae-v1');

/* ---- what this desk actually operates at ----

   Four nullable columns, one per number the desk may tighten. NULL means
   "follow the pack". Deliberately NOT defaulted to the pack's value:
   copying the number down at creation time would freeze it, so a pack
   correction — the whole reason packs are versioned — would move nobody. */
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS report_threshold numeric(24,2);
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS id_threshold numeric(24,2);
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS aggregation_hours integer;
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS retention_years integer;

/* The floor is zero, not the pack's number.

   It is tempting to have the database refuse anything above the pack —
   "you cannot be less strict than the law" enforced in a CHECK. It is
   the wrong place for it. A pack is versioned and a threshold can be
   corrected downward, which would instantly make every desk sitting at
   the old figure unwritable and, worse, would fail the UPDATE that was
   trying to fix them. The relationship between the two numbers is a
   POSTURE the desk is told about — plainly, and loudly when it is
   non-compliant — not a constraint that stops a row existing. Only the
   arithmetic is guarded here: a negative or zero threshold is not a
   strict desk, it is a broken one. */
ALTER TABLE legal_entities
  DROP CONSTRAINT IF EXISTS legal_entities_report_threshold_check;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_report_threshold_check
    CHECK (report_threshold IS NULL OR report_threshold > 0);

ALTER TABLE legal_entities
  DROP CONSTRAINT IF EXISTS legal_entities_id_threshold_check;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_id_threshold_check
    CHECK (id_threshold IS NULL OR id_threshold > 0);

ALTER TABLE legal_entities
  DROP CONSTRAINT IF EXISTS legal_entities_aggregation_hours_check;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_aggregation_hours_check
    CHECK (aggregation_hours IS NULL OR (aggregation_hours > 0 AND aggregation_hours <= 24 * 31));

ALTER TABLE legal_entities
  DROP CONSTRAINT IF EXISTS legal_entities_retention_years_check;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_retention_years_check
    CHECK (retention_years IS NULL OR (retention_years > 0 AND retention_years <= 100));

/* Nothing is backfilled. Every desk that exists today has made no choice
   about any of this — the browser held a number, the server never did —
   and NULL states exactly that. Writing the pack's figure into every row
   would look identical on screen and mean something completely
   different: that every owner in the product had deliberately pinned
   their thresholds, and would therefore never be moved by a pack
   correction again. */
