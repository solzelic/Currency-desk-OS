/* Playwright boots this file. The production entry is src/index.ts, and
   that file does not import the desk reset. */
import { bootServer, listenServer } from "./index.js";
import { ledgerPoolFor } from "./ledger/routes.js";
import { registerTestDeskReset } from "./ledger/test-desk-reset.js";
import { openTestMailbox } from "./email-test-mailbox.js";

const started = await bootServer();
/* Sign-up codes are never logged; the browser suite reads them here instead. */
openTestMailbox(started.app);
const databaseUrl = process.env.LEDGER_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const pool = ledgerPoolFor(started.app);
if (pool) registerTestDeskReset(started.app, pool, databaseUrl);
await listenServer(started.app, started.db);
