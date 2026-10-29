/* Checked-out client. The pool listener does not see this error. */
import { EventEmitter } from "node:events";
import pg from "pg";
import { attachPoolErrorHandler } from "../src/db/pool-error.js";

const pool = new pg.Pool({ connectionString: "postgres://127.0.0.1:1/none" });
attachPoolErrorHandler(pool);
const client = new EventEmitter();
pool.emit("connect", client as never);
const err = new Error("Connection terminated unexpectedly password=secretpassword");
(err as Error & { client?: unknown }).client = { connectionParameters: { password: "from-the-client" } };
setImmediate(() => { client.emit("error", err); });
setTimeout(() => { process.exit(0); }, 80);
