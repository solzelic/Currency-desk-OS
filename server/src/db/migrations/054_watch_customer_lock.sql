/* A reversal can take a customer off the structuring watch. A new deal
   can only add one, so this lock is not taken on ledger_transactions.
   The lock ends when the reversal transaction commits or rolls back.
   This file does not replace ledger_append_only, ledger_tx_immutable,
   ledger_audit_immutable, or ledger_report_filings_sealed. */

CREATE OR REPLACE FUNCTION ledger_lock_watch_customer(
  tenant text,
  entity text,
  branch text,
  customer text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF tenant IS NULL
    OR entity IS NULL
    OR branch IS NULL
    OR customer IS NULL
  THEN
    RAISE EXCEPTION
      'ledger_lock_watch_customer requires tenant, entity, branch, and customer';
  END IF;
  /* chr(31) keeps two different tuples from joining into one string.
     Seed 0 keeps this function's key stable. */
  PERFORM pg_advisory_xact_lock(hashtextextended(
    tenant || chr(31) || entity || chr(31) || branch || chr(31) || customer,
    0
  ));
END;
$$;

CREATE OR REPLACE FUNCTION ledger_reversal_watch_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deal_tenant text;
  deal_entity text;
  deal_branch text;
  deal_customer text;
BEGIN
  SELECT tenant_id, legal_entity_id, branch_id, customer_id
    INTO deal_tenant, deal_entity, deal_branch, deal_customer
    FROM ledger_transactions
   WHERE transaction_id = NEW.transaction_id;
  IF FOUND THEN
    PERFORM ledger_lock_watch_customer(
      deal_tenant, deal_entity, deal_branch, deal_customer
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledger_reversal_watch_lock ON ledger_reversals;
CREATE TRIGGER ledger_reversal_watch_lock
  BEFORE INSERT ON ledger_reversals
  FOR EACH ROW
  EXECUTE FUNCTION ledger_reversal_watch_lock();
