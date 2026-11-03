/* Staging CLI (#609 PR B). There is no HTTP route for any of this.
     npm run staging -- mark-db      insert the one 'staging' row
     npm run staging -- reset-pins   run the staging PIN reset now
   Both read DATABASE_URL, the app's own connection: there is one database
   role today. mark-db refuses unless isStagingRuntime is true. There is no
   'live' insert, because no row already counts as live. This file is the
   only one allowed to insert into db_environment (pin-repeat-rule.test.ts). */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { isStagingRuntime } from "../auth/staging-runtime.js";
import { runStagingPinReset } from "./pin-reset.js";

type Log = { warn: (m: string) => void; error: (m: string) => void };

export async function markStagingDatabase(
  pool: Pick<pg.Pool, "query">, env: NodeJS.ProcessEnv = process.env, log: Log = console,
): Promise<"refused" | "already" | "inserted"> {
  if (!isStagingRuntime(undefined, env)) {
    log.error("[staging] mark-db refused: this is not a staging runtime.");
    return "refused";
  }
  if ((await pool.query("SELECT 1 FROM db_environment")).rows.length > 0) {
    log.warn("[staging] mark-db: the database already has its row. Nothing done.");
    return "already";
  }
  await pool.query("INSERT INTO db_environment (environment) VALUES ('staging')");
  await pool.query(
    "INSERT INTO audit_events (id, tenant_id, legal_entity_id, branch_id, actor_id, action, detail) VALUES ($1, 'platform', 'platform', 'platform', 'system', 'db.environment_marked', $2)",
    [randomUUID(), JSON.stringify({ environment: "staging", host: env.RENDER_EXTERNAL_HOSTNAME ?? "" })],
  );
  log.warn("[staging] mark-db: this database is marked staging.");
  return "inserted";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (!process.env.DATABASE_URL || (command !== "mark-db" && command !== "reset-pins")) {
    console.error("Usage: npm run staging -- mark-db | reset-pins   (needs DATABASE_URL)");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (command === "mark-db") process.exitCode = (await markStagingDatabase(pool)) === "refused" ? 1 : 0;
    else await runStagingPinReset(pool);
  } finally {
    await pool.end();
  }
}
