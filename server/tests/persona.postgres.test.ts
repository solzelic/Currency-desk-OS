/* The append-only trigger and the health-card CHECK are in migration
   048. PGlite does not run the SQL migrations, so this file is the one
   that proves them on Postgres. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { createDb, type DbHandle } from "../src/db/index.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let handle: DbHandle;

postgres("persona inquiry events on Postgres", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO persona_inquiry_events (event_id, inquiry_id, event_name, status, id_type, environment)
       VALUES ('evt_append_only', 'inq_append_only', 'inquiry.approved', 'approved', 'passport', 'sandbox')
       ON CONFLICT (event_id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await handle.close();
    delete process.env.DATABASE_URL;
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

  it("refuses a health card as the ID type", async () => {
    await expect(pool.query(
      `INSERT INTO persona_inquiry_events (event_id, inquiry_id, event_name, status, id_type, environment)
       VALUES ('evt_health_card', 'inq_health_card', 'inquiry.approved', 'approved', 'health_card', 'sandbox')`,
    )).rejects.toThrow(/check constraint/);
  });

  it("stores a replayed event id once", async () => {
    const again = await pool.query(
      `INSERT INTO persona_inquiry_events (event_id, inquiry_id, event_name, status, environment)
       VALUES ('evt_append_only', 'inq_append_only', 'inquiry.approved', 'approved', 'sandbox')
       ON CONFLICT (event_id) DO NOTHING`,
    );
    expect(again.rowCount).toBe(0);
  });
});
