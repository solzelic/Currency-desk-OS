-- Maker and checker are two people (CD-140, GitHub #630).
--
-- A till takeover's approver is never the person whose action it is.
-- The server refuses that before the PIN is read (till-control.ts,
-- selfApproval); this rule makes the table refuse it too, whatever the
-- server checked. Older rows have no approver at all, so none breaks it.
--
-- NOT VALID adds the rule without scanning the table; VALIDATE then
-- proves every row already keeps it, so a deploy on a big table does
-- not hold a lock while it reads.
ALTER TABLE ledger_audit_events
  ADD CONSTRAINT ledger_audit_events_no_self_approval
  CHECK (approver_id IS NULL OR approver_id <> actor_id) NOT VALID;

ALTER TABLE ledger_audit_events
  VALIDATE CONSTRAINT ledger_audit_events_no_self_approval;
