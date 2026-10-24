/* The seam suite shares one database and one worker. A till left open,
   or a drawer left at the figure a previous test counted, is what the
   next test then treats as the seeded desk. Counts cannot be deleted.
   A closed session is still the latest session, and the drawer then
   does not offer Open the till. This closes the seeded York till's
   sessions and moves them off that drawer, and puts the four opening
   figures back. The production server does not import this file. */
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import type pg from "pg";

const require = createRequire(import.meta.url);
const parseConnectionString = require("pg-connection-string") as (
  value: string,
) => { host?: string | null };

const SEEDED_TILL = [
  "tnt-yorkfx",
  "le-yorkfx-canada",
  "br-yorkville",
  "ws-yorkville-till-01",
  "till-01",
];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/* The host node-pg will dial. pg-connection-string lets ?host= replace
   the host written in the URL. An empty result is PGHOST, then the
   driver's own default, localhost. Nothing here is logged. */
export function driverHost(env: NodeJS.ProcessEnv, databaseUrl: string): string | null {
  let parsedHost = "";
  try {
    const parsed = parseConnectionString(databaseUrl);
    parsedHost = typeof parsed.host === "string" ? parsed.host : "";
  } catch {
    return null;
  }
  const chosen = parsedHost.trim() || (env.PGHOST ?? "").trim() || "localhost";
  return chosen.replace(/^\[|\]$/g, "");
}

export function testDeskResetEnabled(env: NodeJS.ProcessEnv, databaseUrl: string): boolean {
  if (env.NODE_ENV !== "test" && env.NODE_ENV !== "development") return false;
  if (env.CD_TEST_RESET !== "1") return false;
  if (!databaseUrl) return false;
  const host = driverHost(env, databaseUrl);
  if (!host || host.includes(",") || host.includes("/")) return false;
  return LOCAL_HOSTS.has(host);
}

/* One client for the whole reset. A second checkout from this pool,
   while this transaction still holds the first, is how a till route
   deadlocks under a pool of one. */
export async function resetSeededDesk(client: pg.PoolClient): Promise<number> {
  /* Session numbers on the retired drawer have to stay unique. The
     next open on till-01 starts again at 1, so a second reset would
     otherwise collide with the session this one just moved. */
  const retired = await client.query(
    `UPDATE ledger_till_sessions AS s
        SET status = 'closed',
            closed_by = COALESCE(s.closed_by, s.opened_by),
            closed_at = COALESCE(s.closed_at, now()),
            close_note = COALESCE(s.close_note, 'test reset'),
            till_id = 'till-reset',
            session_number = n.base + n.rn
       FROM (
         SELECT session_id,
                row_number() OVER (ORDER BY session_number) AS rn,
                (SELECT COALESCE(MAX(session_number), 0)
                   FROM ledger_till_sessions
                  WHERE till_id = 'till-reset') AS base
           FROM ledger_till_sessions
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND branch_id = $3
            AND workspace_id = $4 AND till_id = $5
       ) AS n
      WHERE s.session_id = n.session_id`,
    SEEDED_TILL,
  );
  await client.query(
    `UPDATE ledger_till_balances
        SET available_amount = CASE btrim(currency)
          WHEN 'CAD' THEN 25000.00
          WHEN 'USD' THEN 12000.00
          WHEN 'EUR' THEN 7000.00
          WHEN 'GBP' THEN 3500.00
          ELSE available_amount
        END
      WHERE tenant_id = $1
        AND legal_entity_id = $2
        AND branch_id = $3
        AND workspace_id = $4
        AND till_id = $5
        AND btrim(currency) IN ('CAD', 'USD', 'EUR', 'GBP')`,
    SEEDED_TILL,
  );
  return retired.rowCount ?? 0;
}

export function registerTestDeskReset(
  app: FastifyInstance,
  pool: pg.Pool,
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!testDeskResetEnabled(env, databaseUrl)) return;
  app.post("/api/test/reset-desk", async (_req, reply) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const closedSessions = await resetSeededDesk(client);
      await client.query("COMMIT");
      return reply.send({ ok: true, closedSessions });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* The client is released below either way. */
      }
      throw error;
    } finally {
      client.release();
    }
  });
}
