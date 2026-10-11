#!/usr/bin/env node
/* Read-only audit: ledger customers stored as verified who are not
   ID on file.

   The posting gate does not trust ledger_customers.id_status. A row
   that says verified and has no current typed identity document is
   treated as no ID on file. This script lists those rows so an owner
   can see them. It does not update them. The same rule is
   derivedIdStatusSql in server/src/ledger/id-on-file.ts.

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

const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const found = await client.query(
    `SELECT lc.customer_id, lc.tenant_id, lc.legal_entity_id
       FROM ledger_customers lc
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
               AND coalesce(btrim(d.doc_number), '') <> ''
          )
          OR EXISTS (
            SELECT 1 FROM desk_client_identity_documents d
             WHERE d.client_id = lc.client_id
               AND d.tenant_id = lc.tenant_id
               AND d.legal_entity_id = lc.legal_entity_id
               AND d.is_primary
               AND d.expires_on IS NOT NULL
               AND d.expires_on < current_date
          )
        )
      ORDER BY lc.tenant_id, lc.customer_id`,
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
