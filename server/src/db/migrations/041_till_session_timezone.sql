-- 040 is the till balance mark. This file is 041.
--
-- The zone a till was opened in. A later change to branches.timezone
-- names the next session. This session keeps the zone it opened with,
-- so its stored business date and its sign-off window stay put.
-- Null on a session opened before this column existed: those still
-- read the branch's current zone.

ALTER TABLE ledger_till_sessions
  ADD COLUMN IF NOT EXISTS opened_timezone text;
