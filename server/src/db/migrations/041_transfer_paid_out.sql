-- A transfer the partner has already paid to the beneficiary cannot be
-- cancelled by handing the cash back. Null means it has not been paid out.
-- 040 is on main, so this file is 041.
ALTER TABLE ledger_obligations
  ADD COLUMN IF NOT EXISTS paid_out_at timestamptz;
