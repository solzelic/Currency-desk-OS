-- Default cheque fees for a desk that has never stored a schedule.
-- A desk that already has cdos_cheque_schedule_v1, including 0% or null,
-- is left alone. A second run changes nothing. No audit row is written.

UPDATE tenant_state
SET state = jsonb_set(
      state,
      '{cdos_cheque_schedule_v1}',
      to_jsonb('[{"id":"government","label":"Government","feePct":1.5,"feeMin":4,"holdDays":0,"risk":"low"},{"id":"payroll","label":"Payroll","feePct":2,"feeMin":5,"holdDays":1,"risk":"low"},{"id":"certified","label":"Certified / bank draft","feePct":1,"feeMin":5,"holdDays":0,"risk":"low"},{"id":"money_order","label":"Money order","feePct":1.5,"feeMin":4,"holdDays":0,"risk":"low"},{"id":"business","label":"Business","feePct":3,"feeMin":10,"holdDays":3,"risk":"medium"},{"id":"personal","label":"Personal","feePct":3.5,"feeMin":10,"holdDays":5,"risk":"high"}]'::text),
      true
    ),
    version = version + 1,
    updated_at = now()
WHERE NOT (state ? 'cdos_cheque_schedule_v1');

INSERT INTO tenant_state (tenant_id, state, version)
SELECT t.id,
       jsonb_build_object(
         'cdos_cheque_schedule_v1',
         to_jsonb('[{"id":"government","label":"Government","feePct":1.5,"feeMin":4,"holdDays":0,"risk":"low"},{"id":"payroll","label":"Payroll","feePct":2,"feeMin":5,"holdDays":1,"risk":"low"},{"id":"certified","label":"Certified / bank draft","feePct":1,"feeMin":5,"holdDays":0,"risk":"low"},{"id":"money_order","label":"Money order","feePct":1.5,"feeMin":4,"holdDays":0,"risk":"low"},{"id":"business","label":"Business","feePct":3,"feeMin":10,"holdDays":3,"risk":"medium"},{"id":"personal","label":"Personal","feePct":3.5,"feeMin":10,"holdDays":5,"risk":"high"}]'::text)
       ),
       0
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM tenant_state s WHERE s.tenant_id = t.id);
