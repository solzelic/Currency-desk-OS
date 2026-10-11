#!/usr/bin/env node
/* Read-only audit: ledger customers stored as verified who are not
   ID on file.

   The posting gate does not trust ledger_customers.id_status. A row
   that says verified and has no current typed identity document is
   treated as no ID on file. This script lists those rows so an owner
   can see them. It does not update them.

   The predicates are the same ones as documentStandingSql in
   server/src/ledger/id-on-file.ts: a real type (not empty, not
   "Not stated"), a number that is still non-empty after whitespace
   and invisible characters are stripped, and an expiry on or after
   the branch's business date. A blank or missing expiry does not
   count, so a stored-verified row whose only paper has no date is
   listed. The primary flag is not consulted. The business date is the
   calendar date in the branch's time zone, not UTC current_date.

   Usage (do not point this at a database you are not allowed to read):

     DATABASE_URL=postgres://… node scripts/audit-ledger-id-without-document.mjs

   Output is customer id, tenant id, and legal entity id. The customer's
   name is not printed. The session is read-only.
*/
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireFromServer = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "package.json"),
);
const pg = requireFromServer("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

/* Keep this class identical to NUMBER_STRIP_CLASS in id-on-file.ts. */
const NUMBER_STRIP_CLASS = `[ \t\n\r\f\v\u0085\u00A0\u00AD\u034F\u061C\u1680\u180E\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u202A\u202B\u202C\u202D\u202E\u202F\u205F\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\u206A\u206B\u206C\u206D\u206E\u206F\u3000\uFEFF\uFFF9\uFFFA\uFFFB]`;

const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const found = await client.query(
    `SELECT lc.customer_id, lc.tenant_id, lc.legal_entity_id
       FROM ledger_customers lc
       LEFT JOIN branches b ON b.id = lc.branch_id
      WHERE lower(btrim(lc.id_status)) = 'verified'
        AND (
          lc.client_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM desk_client_identity_documents d
             WHERE d.client_id = lc.client_id
               AND d.tenant_id = lc.tenant_id
               AND d.legal_entity_id = lc.legal_entity_id
               AND coalesce(btrim(d.doc_type), '') <> ''
               AND lower(btrim(d.doc_type)) <> 'not stated'
               AND length(regexp_replace(coalesce(d.doc_number, ''), $1, '', 'g')) > 0
               AND d.expires_on >= (
                 CURRENT_TIMESTAMP AT TIME ZONE COALESCE(NULLIF(btrim(b.timezone), ''), 'America/Toronto')
               )::date
          )
        )
      ORDER BY lc.tenant_id, lc.customer_id`,
    [NUMBER_STRIP_CLASS],
  );
  await client.query("ROLLBACK");
  if (!found.rowCount) {
    console.log("No ledger customer is stored as verified without a current typed identity document.");
  } else {
    console.log(`${found.rowCount} ledger customer(s) stored as verified without a current typed identity document.`);
    console.log("The posting gate treats these as no ID on file. Nothing was changed.");
    for (const row of found.rows) {
      console.log(`${row.customer_id}\t${row.tenant_id}\t${row.legal_entity_id}`);
    }
  }
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    console.error(rollbackError instanceof Error ? rollbackError.message : rollbackError);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
