/* ============================================================
   Steady-state boot must not reissue the storefront type casts.

   CREATE TABLE IF NOT EXISTS cannot change a column that already
   exists, so the boot DDL still carries ALTER COLUMN … TYPE …
   USING for rate_quotes and rate_boards. That cast is how an old
   double precision column becomes numeric(24,2) / numeric(24,12).

   On Postgres 16, issuing that statement when the type already
   matches does not rewrite the heap (relfilenode stays put) but
   it does take ACCESS EXCLUSIVE and it does write a new
   pg_attribute row (xmin and ctid move). The rest of the boot
   DDL, run on its own, leaves those rows alone. A second boot
   that leaves xmin and ctid unchanged did not run the cast.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/index.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;

const CAST_COLUMNS = [
  ["rate_quotes", "have_amount"],
  ["rate_quotes", "quoted_rate"],
  ["rate_quotes", "receive_amount"],
  ["rate_boards", "buy_margin"],
  ["rate_boards", "sell_margin"],
] as const;

async function attributeRows() {
  const found = await pool.query(
    `SELECT c.relname, a.attname, a.xmin::text AS xmin, a.ctid::text AS ctid
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND (
          (c.relname = 'rate_quotes' AND a.attname IN ('have_amount', 'quoted_rate', 'receive_amount'))
          OR (c.relname = 'rate_boards' AND a.attname IN ('buy_margin', 'sell_margin'))
        )
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attname`,
  );
  return found.rows as { relname: string; attname: string; xmin: string; ctid: string }[];
}

async function columnType(table: string, name: string) {
  const found = await pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS fmt
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = $2 AND NOT a.attisdropped`,
    [table, name],
  );
  return found.rows[0]?.fmt as string | undefined;
}

async function boot() {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    const handle = await createDb();
    await handle.close();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

postgres("boot schema on an already-migrated database", () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }); });
  afterAll(() => pool.end());

  it("does not issue ALTER COLUMN TYPE when the numeric scales are already in place", async () => {
    await boot();
    const before = await attributeRows();
    expect(before.map((row) => `${row.relname}.${row.attname}`)).toEqual([
      "rate_boards.buy_margin",
      "rate_boards.sell_margin",
      "rate_quotes.have_amount",
      "rate_quotes.quoted_rate",
      "rate_quotes.receive_amount",
    ]);
    await boot();
    expect(await attributeRows()).toEqual(before);
  });

  it("still casts a double precision hold or margin up to the ledger scale", async () => {
    await boot();
    await pool.query(`
      ALTER TABLE rate_quotes
        ALTER COLUMN have_amount TYPE double precision USING have_amount::double precision,
        ALTER COLUMN quoted_rate TYPE double precision USING quoted_rate::double precision,
        ALTER COLUMN receive_amount TYPE double precision USING receive_amount::double precision`);
    await pool.query(`
      ALTER TABLE rate_boards
        ALTER COLUMN buy_margin TYPE double precision USING buy_margin::double precision,
        ALTER COLUMN sell_margin TYPE double precision USING sell_margin::double precision`);
    await boot();
    expect(await columnType("rate_quotes", "have_amount")).toBe("numeric(24,2)");
    expect(await columnType("rate_quotes", "receive_amount")).toBe("numeric(24,2)");
    expect(await columnType("rate_quotes", "quoted_rate")).toBe("numeric(24,12)");
    expect(await columnType("rate_boards", "buy_margin")).toBe("numeric(24,12)");
    expect(await columnType("rate_boards", "sell_margin")).toBe("numeric(24,12)");
  });

  it("leaves a fresh database on the same numeric scales", async () => {
    await boot();
    for (const [table, name] of CAST_COLUMNS) {
      const scale = name === "have_amount" || name === "receive_amount" ? "numeric(24,2)" : "numeric(24,12)";
      expect(await columnType(table, name)).toBe(scale);
    }
  });
});
