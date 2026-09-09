/* ============================================================
   SESSION WORKSPACE — which till this login is sitting at.

   `sessions.workspace_id` is already on the boot DDL and the Drizzle
   schema, but a database created before that column was added never
   received it: `CREATE TABLE IF NOT EXISTS` does not add columns.
   Live sessions therefore had nowhere to record the drawer, and the
   money routes fell back to "the only workspace at this branch" —
   a rule that denies every unscoped caller the moment a second till
   exists (issue #34).

   Sign-in stamps the first till at the user's home branch. Moving
   drawers (`POST /api/ledger/till-selection`) updates the same
   column. A request that omits `x-workspace-id` uses this value
   rather than counting workspaces.
   ============================================================ */
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id);
