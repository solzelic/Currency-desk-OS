/* ============================================================
   Storefront holds / board margins are numeric — audit Slice F.

   Boot DDL + migration 024 cast `rate_quotes` amounts/rates and
   `rate_boards` margins from double precision to the ledger's
   numeric scales. This pins the live Postgres types and the
   USING backfill a lived-in database actually runs.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/index.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;

async function column(table: string, name: string) {
  const found = await pool.query(
    `SELECT data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return found.rows[0] as { data_type: string; numeric_precision: number; numeric_scale: number } | undefined;
}

postgres("storefront holds and board margins are numeric", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const handle = await createDb();
    await handle.close();
    delete process.env.DATABASE_URL;
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(() => pool.end());

  it("rate_quotes amounts are money (24,2) and the rate is (24,12)", async () => {
    expect(await column("rate_quotes", "have_amount")).toMatchObject({
      data_type: "numeric",
      numeric_precision: 24,
      numeric_scale: 2,
    });
    expect(await column("rate_quotes", "receive_amount")).toMatchObject({
      data_type: "numeric",
      numeric_precision: 24,
      numeric_scale: 2,
    });
    expect(await column("rate_quotes", "quoted_rate")).toMatchObject({
      data_type: "numeric",
      numeric_precision: 24,
      numeric_scale: 12,
    });
  });

  it("rate_boards margins are rates (24,12), not float8", async () => {
    expect(await column("rate_boards", "buy_margin")).toMatchObject({
      data_type: "numeric",
      numeric_precision: 24,
      numeric_scale: 12,
    });
    expect(await column("rate_boards", "sell_margin")).toMatchObject({
      data_type: "numeric",
      numeric_precision: 24,
      numeric_scale: 12,
    });
  });

  it("casts existing float holds in place without dropping the row", async () => {
    await pool.query("DROP TABLE IF EXISTS storefront_hold_legacy");
    await pool.query(`
      CREATE TABLE storefront_hold_legacy (
        have_amount double precision NOT NULL,
        quoted_rate double precision NOT NULL,
        receive_amount double precision NOT NULL,
        buy_margin double precision NOT NULL,
        sell_margin double precision NOT NULL
      )`);
    await pool.query(
      "INSERT INTO storefront_hold_legacy VALUES (1000.5, 0.719165327418, 719.165327418, 0.015, 0.015)",
    );
    await pool.query(`
      ALTER TABLE storefront_hold_legacy
        ALTER COLUMN have_amount TYPE numeric(24,2) USING have_amount::numeric(24,2),
        ALTER COLUMN quoted_rate TYPE numeric(24,12) USING quoted_rate::numeric(24,12),
        ALTER COLUMN receive_amount TYPE numeric(24,2) USING receive_amount::numeric(24,2),
        ALTER COLUMN buy_margin TYPE numeric(24,12) USING buy_margin::numeric(24,12),
        ALTER COLUMN sell_margin TYPE numeric(24,12) USING sell_margin::numeric(24,12)`);
    const row = (await pool.query("SELECT * FROM storefront_hold_legacy")).rows[0];
    expect(row.have_amount).toBe("1000.50");
    expect(row.receive_amount).toBe("719.17");
    expect(row.quoted_rate).toBe("0.719165327418");
    expect(row.buy_margin).toBe("0.015000000000");
    expect(row.sell_margin).toBe("0.015000000000");
    await pool.query("DROP TABLE storefront_hold_legacy");
  });
});
