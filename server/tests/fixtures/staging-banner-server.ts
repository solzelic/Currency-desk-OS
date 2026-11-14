/* CD-117 browser fixture. No product test endpoint, connected database, mail
   provider or rates worker. The parent supplies an allow-listed environment. */
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { buildApp } from "../../src/app.js";
import { createDb, schema } from "../../src/db/index.js";
import { seed, DEMO } from "../../src/seed.js";
import { hashPin } from "../../src/routes/pin.js";

if (!process.send || process.env.PGLITE_MEMORY !== "1" || process.env.DATABASE_URL || process.env.LEDGER_DATABASE_URL) {
  throw new Error("This fixture requires IPC and its own in-memory database");
}
const handle = await createDb();
await seed(handle.db);
// The PIN route reads the till-session table even with no ledger routes.
// Use its authoritative DDL, not a stubbed switch or a parallel schema. Empty
// means this fixture's drawer has not been counted; no cash is exercised here.
const tillControl = await readFile(new URL("../../src/db/migrations/006_till_control.sql", import.meta.url), "utf8");
const tillSessionsDdl = tillControl.split(";")[0]!;
if (!tillSessionsDdl.startsWith("CREATE TABLE IF NOT EXISTS ledger_till_sessions (")) {
  throw new Error("Unexpected till-control migration shape");
}
await handle.db.execute(sql.raw(tillSessionsDdl));
const [owner] = await handle.db.select().from(schema.staffUsers)
  .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:j.masri`));
if (!owner) throw new Error("Missing fixture owner");
for (const [staffId, mustChangePassword] of [["banner@example.invalid", false], ["banner.force", true]] as const) {
  await handle.db.insert(schema.staffUsers).values({
    ...owner, id: `${DEMO.tenantId}:${staffId}`, staffId, mustChangePassword,
  });
}
await handle.db.update(schema.staffUsers).set({ pinHash: await hashPin("4829"), pinMustChange: false, pinSetAt: new Date() })
  .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
const app = await buildApp(handle.db);
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("No fixture port");
process.send({ port: address.port });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await app.close(); } finally { await handle.close(); process.exit(0); }
};
process.on("message", (message) => { if (message === "close") void close(); });
process.on("disconnect", () => void close());
process.on("SIGTERM", () => void close());
