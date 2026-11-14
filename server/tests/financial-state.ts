import type pg from "pg";

/* Snapshot persisted rows, not only counts: a refused request must neither
   append a journal/idempotency record nor change balances or a quote's state.
   Authentication may refresh ledger_principals; that is not a money write.
   Keep numeric values in PostgreSQL's JSON text, without JS number rounding. */
export async function financialState(pool: pg.Pool) {
  const tables = await pool.query<{ name: string }>(`
    SELECT tablename AS name FROM pg_tables
    WHERE schemaname='public' AND (
      (left(tablename,7)='ledger_' AND tablename <> 'ledger_principals')
      OR tablename IN ('quotes','quote_events','quote_overrides','audit_events')
    ) ORDER BY tablename
  `);
  const state: Record<string, string[]> = {};
  for (const { name } of tables.rows) {
    const identifier = '"' + name.replace(/"/g, '""') + '"';
    const rows = await pool.query<{ row: string }>(
      `SELECT to_jsonb(t)::text AS row FROM public.${identifier} t ORDER BY 1`,
    );
    state[name] = rows.rows.map(({ row }) => row);
  }
  return state;
}
