/* A change of the book's currency restates what the cash cost, in the
   new home currency. The restatement is a new event. Rows already on
   ledger_cost_events stay as they were written: that table is
   append-only, and a cost that was true in the old currency is still
   true as a fact about that day.

   The check below is the list from 010_cost_basis.sql, plus rebase.
   That migration is already applied, so this file adds the kind
   instead of editing it. */
ALTER TABLE ledger_cost_events DROP CONSTRAINT IF EXISTS ledger_cost_events_event_kind_check;
ALTER TABLE ledger_cost_events ADD CONSTRAINT ledger_cost_events_event_kind_check
  CHECK (event_kind IN (
    'opening',
    'opening_estimated',
    'purchase',
    'delivery',
    'transfer_in',
    'transfer_out',
    'sale',
    'withdrawal',
    'reversal',
    'rebase'
  ));
