/* Playwright boots this file. The production entry is src/index.ts, and
   that file does not import the desk reset. */
import { bootServer, listenServer } from "./index.js";
import { markTestShop } from "./seed.js";
import { ledgerPoolFor } from "./ledger/routes.js";
import { registerTestDeskReset } from "./ledger/test-desk-reset.js";

const started = await bootServer();
/* The demo shop this harness walks is a test shop, so Transfers stay on
   for the specs that send one (CD-111). Staging marks it the same way. */
await markTestShop(started.db);
const databaseUrl = process.env.LEDGER_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const pool = ledgerPoolFor(started.app);
if (pool) registerTestDeskReset(started.app, pool, databaseUrl);
await listenServer(started.app, started.db);
