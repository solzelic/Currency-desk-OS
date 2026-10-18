/* A schedule whose floor is zero. Older cheque tests send the fee
   they mean to book. A missing schedule is a refusal, so those
   desks need a stored schedule that their fee still meets. */
const ROWS = ["government", "payroll", "certified", "money_order", "business", "personal"].map((id) => ({
  id, label: id, feePct: 0, feeMin: 0, holdDays: 0, risk: "low",
}));

export async function zeroFloorSchedule(
  pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  tenantId: string,
) {
  await pool.query(
    `INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 0)
     ON CONFLICT (tenant_id) DO UPDATE SET state = tenant_state.state || EXCLUDED.state`,
    [tenantId, JSON.stringify({ cdos_cheque_schedule_v1: JSON.stringify(ROWS) })],
  );
}
