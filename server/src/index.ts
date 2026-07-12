import { createDb } from "./db/index.js";
import { seed } from "./seed.js";
import { buildApp } from "./app.js";

const handle = await createDb();
// dev convenience: embedded DB is seeded on boot; against real Postgres
// (DATABASE_URL) seeding is an explicit `npm run seed`.
if (!process.env.DATABASE_URL) {
  await seed(handle.db);
}

const app = await buildApp(handle.db);
const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "127.0.0.1" });
console.log(`currencydesk-server on http://127.0.0.1:${port}`);
