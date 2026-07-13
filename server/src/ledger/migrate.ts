import { createDb } from "../db/index.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for ledger migrations.");
const database = await createDb();
await database.close();
console.log("database migrations applied");
