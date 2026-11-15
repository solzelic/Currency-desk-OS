/* Who may decide, and the rows that decision leaves behind.
   Decisions are append-only and kept for 5 years.
   A confirmed match cannot later be cleared.
   The listed-person task is recorded, not filed. */
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS compliance_officer_staff_id text;

DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
   WHERE nsp.nspname = 'public'
     AND rel.relname = 'desk_clients'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) LIKE '%screening_outcome%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE desk_clients DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE desk_clients
  ADD CONSTRAINT desk_clients_screening_outcome_check
  CHECK (screening_outcome IS NULL OR screening_outcome IN ('clear', 'hit', 'pending', 'not_screened'));

ALTER TABLE sanctions_review_decisions
  ADD COLUMN IF NOT EXISTS retain_until timestamptz;
UPDATE sanctions_review_decisions
   SET retain_until = created_at + interval '5 years'
 WHERE retain_until IS NULL;
ALTER TABLE sanctions_review_decisions
  ALTER COLUMN retain_until SET DEFAULT (now() + interval '5 years');
ALTER TABLE sanctions_review_decisions
  ALTER COLUMN retain_until SET NOT NULL;

CREATE OR REPLACE FUNCTION sanctions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sanctions review rows are append-only and kept for 5 years';
END;
$$;

DROP TRIGGER IF EXISTS sanctions_review_decisions_append_only ON sanctions_review_decisions;
CREATE TRIGGER sanctions_review_decisions_append_only
  BEFORE UPDATE OR DELETE ON sanctions_review_decisions
  FOR EACH ROW EXECUTE FUNCTION sanctions_append_only();

DROP TRIGGER IF EXISTS sanctions_review_decisions_no_truncate ON sanctions_review_decisions;
CREATE TRIGGER sanctions_review_decisions_no_truncate
  BEFORE TRUNCATE ON sanctions_review_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION sanctions_append_only();

CREATE OR REPLACE FUNCTION sanctions_confirmed_stays() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'confirmed' AND NEW.status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'a confirmed match cannot be cleared';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sanctions_reviews_confirmed_stays ON sanctions_reviews;
CREATE TRIGGER sanctions_reviews_confirmed_stays
  BEFORE UPDATE ON sanctions_reviews
  FOR EACH ROW EXECUTE FUNCTION sanctions_confirmed_stays();

CREATE TABLE IF NOT EXISTS sanctions_officer_tasks (
  task_id text PRIMARY KEY,
  review_id text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  instruction text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '5 years'),
  done_at timestamptz,
  done_by text
);

CREATE OR REPLACE FUNCTION sanctions_task_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sanctions officer tasks are kept for 5 years';
  END IF;
  IF OLD.done_at IS NOT NULL THEN
    RAISE EXCEPTION 'sanctions officer task is already recorded';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sanctions_officer_tasks_once ON sanctions_officer_tasks;
CREATE TRIGGER sanctions_officer_tasks_once
  BEFORE UPDATE OR DELETE ON sanctions_officer_tasks
  FOR EACH ROW EXECUTE FUNCTION sanctions_task_once();
