import type pg from "pg";

/* A current passport on the customer's own client. The column is not standing. */
export async function fileCurrentPhotoId(pool: pg.Pool, customerId: string): Promise<void> {
  const found = await pool.query(
    `SELECT tenant_id, legal_entity_id, name, client_id
       FROM ledger_customers WHERE customer_id = $1`,
    [customerId],
  );
  const row = found.rows[0];
  if (!row) throw new Error(`No ledger customer ${customerId}`);
  let clientId = row.client_id as string | null;
  if (!clientId) {
    clientId = `cli-photo-${customerId}`;
    await pool.query(
      `INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id) DO NOTHING`,
      [clientId, row.tenant_id, row.legal_entity_id, row.name],
    );
    await pool.query(
      `UPDATE ledger_customers SET client_id = $2 WHERE customer_id = $1 AND client_id IS NULL`,
      [customerId, clientId],
    );
  }
  const documentId = `doc-photo-${customerId}`;
  await pool.query("DELETE FROM desk_client_identity_documents WHERE document_id = $1", [documentId]);
  await pool.query(
    `INSERT INTO desk_client_identity_documents
       (document_id, client_id, tenant_id, legal_entity_id,
        doc_type, doc_number, expires_on, is_primary)
     SELECT $1, $2, $3, $4, 'Passport', $5, DATE '2032-04-01',
            NOT EXISTS (
              SELECT 1 FROM desk_client_identity_documents
               WHERE client_id = $2 AND is_primary
            )`,
    [documentId, clientId, row.tenant_id, row.legal_entity_id, `P-${customerId}`.slice(0, 40)],
  );
}

export async function clearPhotoId(pool: pg.Pool, customerId: string): Promise<void> {
  await pool.query("UPDATE ledger_customers SET client_id = NULL WHERE customer_id = $1", [customerId]);
}
