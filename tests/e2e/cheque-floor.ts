/* Older seam desks name the fee they mean to book. A missing
   schedule is a refusal, so those desks store a zero floor. */
import path from "node:path";
import { createRequire } from "node:module";
import { zeroFloorSchedule } from "../../server/tests/zeroFloorSchedule.js";

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    end: () => Promise<void>;
  };
};

export async function seedZeroFloor(tenantId = "tnt-yorkfx") {
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await zeroFloorSchedule(pool, tenantId);
  } finally {
    await pool.end();
  }
}

/** A desk with no stored schedule, so cashing is refused. */
export async function clearChequeSchedule(tenantId = "tnt-yorkfx") {
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query("UPDATE tenant_state SET state = state - $2 WHERE tenant_id = $1", [
      tenantId,
      "cdos_cheque_schedule_v1",
    ]);
  } finally {
    await pool.end();
  }
}

/** Store one schedule. The cashing floor is this copy, not the screen's. */
export async function storeChequeSchedule(schedule: unknown, tenantId = "tnt-yorkfx") {
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query(
      `INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 0)
       ON CONFLICT (tenant_id) DO UPDATE SET state = tenant_state.state || EXCLUDED.state`,
      [tenantId, JSON.stringify({ cdos_cheque_schedule_v1: JSON.stringify(schedule) })],
    );
  } finally {
    await pool.end();
  }
}
