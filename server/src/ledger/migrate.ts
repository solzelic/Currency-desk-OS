import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for ledger migrations.");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(await readFile(resolve(process.cwd(), "src/ledger/migration.sql"), "utf8"));
await pool.end();
console.log("ledger migration applied");
