import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
let pool: Pool;

integration("PostgreSQL ledger schema", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const sql = await readFile(resolve(process.cwd(), "server/db/migrations/001_ledger_posting.sql"), "utf8");
    await pool.query(sql);
  });
  afterAll(async () => { await pool?.end(); });

  it("enforces a scoped idempotency key exactly once", async () => {
    const scope = ["test-tenant", "test-le", "test-branch", "test-workspace", "test-till", "retry-key"];
    await pool.query("DELETE FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND idempotency_key=$6", scope);
    const [first, second] = await Promise.all([
      pool.query("INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", scope),
      pool.query("INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", scope)
    ]);
    expect(first.rowCount! + second.rowCount!).toBe(1);
  });
});
