/* The append-only trigger is in the SQL migration. PGlite does not run
   that migration, so this check is the one that proves an update and a
   delete are refused on Postgres. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;

postgres("persona inquiry events are append-only", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO persona_inquiry_events (event_id, inquiry_id, event_name, status, environment)
       VALUES ('evt_append_only', 'inq_append_only', 'inquiry.approved', 'approved', 'sandbox')
       ON CONFLICT (event_id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("refuses an update", async () => {
    await expect(pool.query(
      "UPDATE persona_inquiry_events SET status = 'declined' WHERE event_id = 'evt_append_only'",
    )).rejects.toThrow(/append-only/);
  });

  it("refuses a delete", async () => {
    await expect(pool.query(
      "DELETE FROM persona_inquiry_events WHERE event_id = 'evt_append_only'",
    )).rejects.toThrow(/append-only/);
  });
});
