-- A transfer the partner has already paid to the beneficiary cannot be
-- cancelled by handing the cash back. Null means it has not been paid out.
--
-- Live schema: ledger_obligations and ledger_reversals are created by
-- 001_ledger and 018_obligations. They are not in the Drizzle DDL, so a
-- database that is already running receives these columns only when this
-- migration applies. Existing obligations keep paid_out_at null. Existing
-- reversals keep business_date and till_session_id null.
--
-- 041 is already claimed by open PRs (persona events, till-session
-- timezone). 040 is the last migration on main, so this file is 042.
-- The cancel date is the branch calendar day (branches.timezone).
-- PR #128's businessDate(at, timeZone) helper is not on main. A branch
-- with no timezone keeps the open session's stored business_date.
-- Boot applies this file. A copy of the live schema has not been used
-- to rehearse it.
ALTER TABLE ledger_obligations
  ADD COLUMN IF NOT EXISTS paid_out_at timestamptz;

ALTER TABLE ledger_reversals
  ADD COLUMN IF NOT EXISTS business_date date;

ALTER TABLE ledger_reversals
  ADD COLUMN IF NOT EXISTS till_session_id text;
