import type pg from "pg";

/* A typed identity document on the client the ledger row points at.
   Tests that used to mean "this customer is identified" by writing
   id_status = 'verified' now file the paper the posting gate reads.
   The stored column is left alone. */
export async function fileTypedId(
  pool: pg.Pool | pg.PoolClient,
  customerId: string,
  opts: { expiresOn?: string | null; number?: string } = {},
): Promise<void> {
  const found = await pool.query(
    `SELECT tenant_id, legal_entity_id, name, client_id
       FROM ledger_customers WHERE customer_id = $1`,
    [customerId],
  );
  if (!found.rowCount) throw new Error(`no ledger customer ${customerId}`);
  const row = found.rows[0]!;
  const clientId = (row.client_id as string | null) ?? `cli_typed_${customerId}`;
  await pool.query(
    `INSERT INTO desk_clients
       (client_id, tenant_id, legal_entity_id, display_name, verification_status)
     VALUES ($1,$2,$3,$4,'identified')
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, row.tenant_id, row.legal_entity_id, row.name],
  );
  await pool.query(
    `INSERT INTO desk_client_identity_documents
       (document_id, client_id, tenant_id, legal_entity_id,
        doc_type, doc_number, expires_on, is_primary)
     VALUES ($1,$2,$3,$4,'Passport',$5,$6,true)
     ON CONFLICT (document_id) DO UPDATE
       SET doc_number = EXCLUDED.doc_number,
           expires_on = EXCLUDED.expires_on,
           is_primary = true`,
    [
      `doc_typed_${customerId}`,
      clientId,
      row.tenant_id,
      row.legal_entity_id,
      opts.number ?? `P-${customerId}`,
      opts.expiresOn === undefined ? "2032-04-01" : opts.expiresOn,
    ],
  );
  await pool.query(
    `UPDATE ledger_customers SET client_id = $2 WHERE customer_id = $1 AND client_id IS NULL`,
    [customerId, clientId],
  );
}

/* The inverse of fileTypedId. A later assertion that this customer is
   unidentified has to remove the paper; clearing the column does not. */
export async function clearTypedId(
  pool: pg.Pool | pg.PoolClient,
  customerId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM desk_client_identity_documents d
      USING ledger_customers lc
      WHERE lc.customer_id = $1 AND d.client_id = lc.client_id`,
    [customerId],
  );
}
