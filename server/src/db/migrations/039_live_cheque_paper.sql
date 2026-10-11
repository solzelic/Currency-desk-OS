/* One live cheque per piece of paper on a branch.

   Cashing built its idempotency key from the clock, so two taps of the
   same form were two keys. Cheque 1002841 was paid twice. The form now
   keeps one key until that cashing finishes. This index is the backstop
   when a second key still arrives: the same number, payer and bank
   cannot be held twice at the same branch. A cleared, returned or
   reversed cheque is not in the index, so the number can be cashed
   again after the first one is no longer outstanding.

   038 is the last migration on main. This file is 039, the next number.

   A book can already hold two live copies of the same cheque. That is
   the bug this index exists to stop, and creating the index over those
   rows would abort boot. The older copy stays on the book — the cash
   is still out — and is left out of the index. paper_guard is false on
   that row. The newest held copy keeps paper_guard true and is the row
   the index watches. "Newest" is created_at, then cheque_id, so two
   rows written in the same instant still have one winner.

   A human can list the copies that were set aside:

     SELECT cheque_id, cheque_ref, cheque_number, maker, drawee_bank, created_at
       FROM ledger_cheques
      WHERE paper_guard = false;

   A new cashing does not set the column. It defaults to true, so the
   index still refuses a second live copy. */
ALTER TABLE ledger_cheques
  ADD COLUMN IF NOT EXISTS paper_guard boolean NOT NULL DEFAULT true;

UPDATE ledger_cheques AS older
   SET paper_guard = false
 WHERE older.status = 'held'
   AND EXISTS (
     SELECT 1
       FROM ledger_cheques AS newer
      WHERE newer.status = 'held'
        AND newer.tenant_id = older.tenant_id
        AND newer.legal_entity_id = older.legal_entity_id
        AND newer.branch_id = older.branch_id
        AND newer.cheque_number = older.cheque_number
        AND lower(btrim(newer.maker)) = lower(btrim(older.maker))
        AND lower(btrim(coalesce(newer.drawee_bank, '')))
            = lower(btrim(coalesce(older.drawee_bank, '')))
        AND (newer.created_at, newer.cheque_id)
            > (older.created_at, older.cheque_id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS ledger_cheques_live_paper_idx
  ON ledger_cheques (
    tenant_id,
    legal_entity_id,
    branch_id,
    cheque_number,
    lower(btrim(maker)),
    lower(btrim(coalesce(drawee_bank, '')))
  )
  WHERE status = 'held' AND paper_guard;
