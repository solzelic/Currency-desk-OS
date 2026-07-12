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
// bind all interfaces in production (Render/Railway route external traffic);
// loopback-only in dev
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port, host });
console.log(`currencydesk-server on http://${host}:${port}`);
