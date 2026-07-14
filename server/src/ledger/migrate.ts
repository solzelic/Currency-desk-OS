import pg from "pg";
import { runMigrations } from "../db/migrations.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for ledger migrations.");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await runMigrations(pool);
await pool.end();
console.log("database migrations applied");
