/* One live cheque per piece of paper on a branch.

   Cashing built its idempotency key from the clock, so two taps of the
   same form were two keys. Cheque 1002841 was paid twice. The form now
   keeps one key until that cashing finishes. This index is the backstop
   when a second key still arrives: the same number, payer and bank
   cannot be held twice at the same branch. A cleared, returned or
   reversed cheque is not in the index, so the number can be cashed
   again after the first one is no longer outstanding.

   027 and 030 are still open drafts. 039 stays. */
CREATE UNIQUE INDEX IF NOT EXISTS ledger_cheques_live_paper_idx
  ON ledger_cheques (
    tenant_id,
    legal_entity_id,
    branch_id,
    cheque_number,
    lower(btrim(maker)),
    lower(btrim(coalesce(drawee_bank, '')))
  )
  WHERE status = 'held';
