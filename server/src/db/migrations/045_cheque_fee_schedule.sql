-- Default cheque fees where a desk has no schedule.
-- Missing: no row, no key, JSON null, "", "[]", or text that is not a
-- non-empty JSON array. A stored schedule, including 0%, is left
-- byte for byte. One audit row per desk this changes. A second run
-- writes nothing.

DO $$
DECLARE
  def text := '[{"id":"government","label":"Government","feePct":1.5,"feeMin":4,"holdDays":0,"risk":"low"},{"id":"payroll","label":"Payroll","feePct":2,"feeMin":5,"holdDays":1,"risk":"low"},{"id":"certified","label":"Certified / bank draft","feePct":1,"feeMin":5,"holdDays":0,"risk":"low"},{"id":"money_order","label":"Money order","feePct":1.5,"feeMin":4,"holdDays":0,"risk":"low"},{"id":"business","label":"Business","feePct":3,"feeMin":10,"holdDays":3,"risk":"medium"},{"id":"personal","label":"Personal","feePct":3.5,"feeMin":10,"holdDays":5,"risk":"high"}]';
  rec record;
  raw text;
  parsed jsonb;
  missing boolean;
  before_val jsonb;
  le text;
  br text;
BEGIN
  FOR rec IN
    SELECT t.id AS tenant_id,
           s.tenant_id IS NOT NULL AS has_row,
           s.state
    FROM tenants t
    LEFT JOIN tenant_state s ON s.tenant_id = t.id
  LOOP
    missing := false;
    before_val := 'null'::jsonb;
    raw := NULL;
    IF NOT rec.has_row OR rec.state IS NULL OR NOT (rec.state ? 'cdos_cheque_schedule_v1')
       OR jsonb_typeof(rec.state->'cdos_cheque_schedule_v1') = 'null' THEN
      missing := true;
    ELSE
      raw := rec.state->>'cdos_cheque_schedule_v1';
      before_val := to_jsonb(raw);
      IF raw IS NULL OR raw = '' OR raw = '[]' THEN
        missing := true;
      ELSE
        BEGIN
          parsed := raw::jsonb;
          IF jsonb_typeof(parsed) <> 'array' OR jsonb_array_length(parsed) = 0 THEN
            missing := true;
          END IF;
        EXCEPTION WHEN invalid_text_representation THEN
          missing := true;
        END;
      END IF;
    END IF;
    IF NOT missing THEN
      CONTINUE;
    END IF;

    IF NOT rec.has_row THEN
      INSERT INTO tenant_state (tenant_id, state, version)
      VALUES (rec.tenant_id, jsonb_build_object('cdos_cheque_schedule_v1', to_jsonb(def)), 0);
    ELSE
      UPDATE tenant_state
      SET state = jsonb_set(state, '{cdos_cheque_schedule_v1}', to_jsonb(def), true),
          version = version + 1,
          updated_at = now()
      WHERE tenant_id = rec.tenant_id;
    END IF;

    SELECT id INTO le FROM legal_entities WHERE tenant_id = rec.tenant_id LIMIT 1;
    SELECT id INTO br FROM branches WHERE tenant_id = rec.tenant_id LIMIT 1;
    INSERT INTO audit_events (id, tenant_id, legal_entity_id, branch_id, actor_id, action, detail)
    VALUES (
      gen_random_uuid()::text,
      rec.tenant_id,
      COALESCE(le, '-'),
      COALESCE(br, '-'),
      'system migration',
      'cheque.schedule_backfill',
      jsonb_build_object('before', before_val, 'after', to_jsonb(def))
    );
  END LOOP;
END $$;
