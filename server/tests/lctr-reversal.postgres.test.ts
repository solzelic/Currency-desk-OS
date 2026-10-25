/* Issue #319. Cash received stays in the LCTR cluster after a later reversal,
   unless the reason is a booking error set by a reversing role. */
import { createRequire } from "node:module";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { lctrCluster } from "../src/ledger/canada-rules.js";
import { LedgerService, type LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const require = createRequire(import.meta.url);
const { wallInstant } = require("../../shared/rolling-24h.js") as {
  wallInstant: (date: string, time: string, zone: string) => Date | null;
};
const { BOOKING_ERROR_REASON, LEFT_OUT_LINE } = require("../../shared/lctr-reversal.js") as {
  BOOKING_ERROR_REASON: string;
  LEFT_OUT_LINE: string;
};
const ZONE = "America/Toronto";
const DAY1 = "2026-06-15";
const DAY2 = "2026-06-16";
const TENANT = "tnt-lctr319";
const ENTITY = "le-lctr319";
const BRANCH = "br-lctr319";
const WORKSPACE = "ws-lctr319";
const TILL = "till-lctr319";
const SUPERVISOR = "lctr-supervisor";
const TELLER = "lctr-teller";
const scope = {
  tenantId: TENANT, legalEntityId: ENTITY, branchId: BRANCH, workspaceId: WORKSPACE, tillId: TILL,
};
let handle: DbHandle;
let pool: pg.Pool;
let service: LedgerService;

function at(date: string, time: string): Date {
  const instant = wallInstant(date, time, ZONE);
  if (!instant) throw new Error(`no Toronto instant for ${date} ${time}`);
  return instant;
}
function actor(userId: string, role: LedgerActor["role"]): LedgerActor {
  return { userId, ...scope, role, authorizedBranchIds: [BRANCH] };
}
async function deal(id: string, customerId: string, amount: string, postedAt: Date) {
  await pool.query(
    `INSERT INTO ledger_transactions
       (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
        customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
        fee_cad, spread_cad, purpose, source_of_funds, posted_at, deal_kind, received_instrument,
        disbursed_instrument, cash_in_home, cash_out_home, home_currency, third_party, third_party_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CAD','USD',$10,$10,1,0,0,'Travel','Salary',$11,
             'exchange','cash','cash',$10,NULL,'CAD',false,NULL)`,
    [id, `ref-${id}`, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, customerId, TELLER, amount, postedAt],
  );
}
async function reversal(id: string, reason: string, postedAt: Date) {
  await pool.query(
    `INSERT INTO ledger_reversals (reversal_id, transaction_id, actor_id, reason, posted_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [`rv-${id}`, id, SUPERVISOR, reason, postedAt],
  );
}
async function pair(prefix: string, customerId: string) {
  await deal(`${prefix}-1`, customerId, "6000.00", at(DAY1, "14:00:00"));
  await deal(`${prefix}-2`, customerId, "5000.00", at(DAY2, "10:00:00"));
}
async function clusterOf(customerId: string) {
  const client = await pool.connect();
  try {
    return await lctrCluster(client, { legalEntityId: ENTITY, customerId, at: at(DAY2, "10:00:00") });
  } finally {
    client.release();
  }
}
async function kept(prefix: string, customerId: string, reason: string, postedAt: Date) {
  await pair(prefix, customerId);
  await reversal(`${prefix}-1`, reason, postedAt);
  const cluster = await clusterOf(customerId);
  expect(cluster.total).toBe("11000.00");
  expect(cluster.cluster).toBe(true);
  return cluster;
}

postgres("LCTR total keeps reversed cash unless it was a booking error", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    service = new LedgerService(pool);
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [TENANT]);
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ($1,$2,$1,'CAD','pack-ca-v2',2) ON CONFLICT (id) DO NOTHING`,
      [ENTITY, TENANT],
    );
    for (const [userId, role] of [[SUPERVISOR, "supervisor"], [TELLER, "teller"]] as const) {
      await pool.query(
        `INSERT INTO ledger_principals
           (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [userId, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, role, JSON.stringify([BRANCH])],
      );
    }
  });
  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("keeps CAD 6000 at 2 pm and CAD 5000 at 10 am in the cluster after a normal reversal at 4 pm", async () => {
    const cluster = await kept("lctr-n", "lctr-normal", "Customer changed their mind", at(DAY2, "16:00:00"));
    expect(cluster.count).toBe(2);
  });

  it("forms no cluster when the first deal is a booking error", async () => {
    await pair("lctr-b", "lctr-booking");
    await reversal("lctr-b-1", BOOKING_ERROR_REASON, at(DAY2, "16:00:00"));
    const cluster = await clusterOf("lctr-booking");
    expect(cluster.cluster).toBe(false);
    expect(cluster.total).toBe("5000.00");
    expect(cluster.count).toBe(1);
    expect(cluster.leftOut).toEqual([{
      transactionId: "lctr-b-1", line: LEFT_OUT_LINE, by: SUPERVISOR,
      at: at(DAY2, "16:00:00").toISOString(),
    }]);
  });

  it("still counts a reversal with no reason", async () => {
    await kept("lctr-z", "lctr-noreason", "", at(DAY2, "16:00:00"));
  });

  it("still counts a reversal posted inside the window", async () => {
    await kept("lctr-i", "lctr-inside", "Customer changed their mind", at(DAY1, "15:00:00"));
  });

  it("refuses a teller who sets the booking-error reason, and the deal stays in the total", async () => {
    await pair("lctr-t", "lctr-teller");
    let refused: unknown = null;
    try {
      await service.reverse(actor(TELLER, "teller"), "lctr-t-1", "teller-booking", BOOKING_ERROR_REASON);
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      code: "AUTHORIZATION_DENIED",
      message: "Only a supervisor, branch manager, or administrator can record a booking error. Nothing was reversed.",
    });
    const cluster = await clusterOf("lctr-teller");
    expect(cluster.total).toBe("11000.00");
    expect(cluster.cluster).toBe(true);
    const rows = await pool.query(
      "SELECT reversal_id FROM ledger_reversals WHERE transaction_id = $1", ["lctr-t-1"],
    );
    expect(rows.rowCount).toBe(0);
  });
});
