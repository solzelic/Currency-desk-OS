/* Issue #319. Cash received stays in the LCTR total after a reversal,
   unless the reason is a booking error set by a reversing role. */
import { createRequire } from "node:module";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { cashReceived } from "../src/ledger/canada-rules.js";
import { ReportFilingService } from "../src/ledger/report-filings.js";
import { LedgerService, type LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const require = createRequire(import.meta.url);
const { wallInstant } = require("../../shared/rolling-24h.js") as {
  wallInstant: (date: string, time: string, zone: string) => Date | null;
};
const { BOOKING_ERROR_REASON, countsTowardLctr, FILING_FLAG_FILED, FILING_FLAG_PREPARED } = require("../../shared/lctr-reversal.js") as {
  BOOKING_ERROR_REASON: string;
  countsTowardLctr: (reason: unknown) => boolean;
  FILING_FLAG_FILED: string;
  FILING_FLAG_PREPARED: string;
};
const FILED_FLAG = "A deal in this report was later marked booking error. Check if the filed report needs a correction.";
const PREPARED_FLAG = "A deal in this report was later marked booking error. Check the report before you file it.";
const ZONE = "America/Toronto", DAY1 = "2026-06-15", DAY2 = "2026-06-16";
const TENANT = "tnt-lctr319", ENTITY = "le-lctr319", BRANCH = "br-lctr319";
const WORKSPACE = "ws-lctr319", TILL = "till-lctr319";
const SUPERVISOR = "lctr-supervisor", TELLER = "lctr-teller";
const TELLER_MSG = "Only a supervisor, branch manager, or administrator can record a booking error. Nothing was reversed.";
const scope = [TENANT, ENTITY, BRANCH, WORKSPACE, TILL];
let handle: DbHandle, pool: pg.Pool, service: LedgerService;

function at(date: string, time: string): Date {
  const instant = wallInstant(date, time, ZONE);
  if (!instant) throw new Error(`no Toronto instant for ${date} ${time}`);
  return instant;
}
function actor(userId: string, role: LedgerActor["role"]): LedgerActor {
  return { userId, tenantId: TENANT, legalEntityId: ENTITY, branchId: BRANCH, workspaceId: WORKSPACE, tillId: TILL, role, authorizedBranchIds: [BRANCH] };
}
async function deal(id: string, customerId: string, amount: string, postedAt: Date) {
  await pool.query(
    `INSERT INTO ledger_transactions (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
        customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate, fee_cad, spread_cad, purpose, source_of_funds,
        posted_at, deal_kind, received_instrument, disbursed_instrument, cash_in_home, cash_out_home, home_currency, third_party, third_party_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CAD','USD',$10,$10,1,0,0,'Travel','Salary',$11,'exchange','cash','cash',$10,NULL,'CAD',false,NULL)`,
    [id, `ref-${id}`, ...scope, customerId, TELLER, amount, postedAt],
  );
}
async function reversal(id: string, reason: string, postedAt: Date) {
  await pool.query(
    "INSERT INTO ledger_reversals (reversal_id, transaction_id, actor_id, reason, posted_at) VALUES ($1,$2,$3,$4,$5)",
    [`rv-${id}`, id, SUPERVISOR, reason, postedAt],
  );
}
async function cashOf(customerId: string) {
  const client = await pool.connect();
  try {
    return (await cashReceived(client, ENTITY, { start: at(DAY1, "00:00:00"), end: at(DAY2, "18:00:00") }, "conductor", customerId)).toFixed(2);
  } finally { client.release(); }
}
async function kept(prefix: string, customerId: string, reason: string, postedAt: Date) {
  await deal(`${prefix}-1`, customerId, "6000.00", at(DAY1, "14:00:00"));
  await deal(`${prefix}-2`, customerId, "5000.00", at(DAY2, "10:00:00"));
  await reversal(`${prefix}-1`, reason, postedAt);
  expect(await cashOf(customerId)).toBe("11000.00");
}
async function placeFiling(id: string, status: "draft" | "filed", ref: string | string[], payload: object) {
  const refs = Array.isArray(ref) ? ref : [ref];
  await pool.query(
    `INSERT INTO ledger_report_filings (filing_id, tenant_id, legal_entity_id, branch_id, report_id, pack_id, pack_version,
        report_code, status, payload, subject_transaction_ids, acknowledgement_ref, created_by)
     VALUES ($1,$2,$3,$4,'rpt-ca-lctr-v2','pack-ca-v2',2,'LCTR',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [id, TENANT, ENTITY, BRANCH, status, JSON.stringify(payload), JSON.stringify(refs), status === "filed" ? `ACK-${id}` : null, SUPERVISOR],
  );
}
async function filingBytes(id: string) {
  const found = await pool.query("SELECT * FROM ledger_report_filings WHERE filing_id=$1", [id]);
  return JSON.stringify(found.rows[0]);
}
async function flagRows(id: string) {
  const found = await pool.query(
    "SELECT transaction_id, actor_id FROM ledger_filing_flags WHERE filing_id=$1 ORDER BY transaction_id",
    [id],
  );
  return found.rows;
}
async function bookingError(transactionId: string, key: string) {
  try {
    await service.reverse(actor(SUPERVISOR, "supervisor"), transactionId, key, BOOKING_ERROR_REASON);
    return null;
  } catch (error) { return error; }
}
async function reversals(id: string) {
  const rows = await pool.query("SELECT reversal_id FROM ledger_reversals WHERE transaction_id=$1", [id]);
  return rows.rowCount;
}

postgres("LCTR total keeps reversed cash unless it was a booking error", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    service = new LedgerService(pool);
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [TENANT]);
    await pool.query(
      `INSERT INTO legal_entities (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ($1,$2,$1,'CAD','pack-ca-v2',2) ON CONFLICT (id) DO NOTHING`,
      [ENTITY, TENANT],
    );
    for (const [userId, role] of [[SUPERVISOR, "supervisor"], [TELLER, "teller"]] as const) {
      await pool.query(
        "INSERT INTO ledger_principals (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [userId, ...scope, role, JSON.stringify([BRANCH])],
      );
    }
  });
  afterAll(async () => { await handle.close(); await pool.end(); delete process.env.DATABASE_URL; });

  it("keeps CAD 6000 and CAD 5000 in cashReceived after a normal reversal", async () => {
    await kept("lctr-n", "lctr-normal", "Customer changed their mind", at(DAY2, "16:00:00"));
  });
  it("leaves a booking error out of cashReceived", async () => {
    await deal("lctr-b-1", "lctr-booking", "6000.00", at(DAY1, "14:00:00"));
    await deal("lctr-b-2", "lctr-booking", "5000.00", at(DAY2, "10:00:00"));
    await reversal("lctr-b-1", BOOKING_ERROR_REASON, at(DAY2, "16:00:00"));
    expect(countsTowardLctr(BOOKING_ERROR_REASON)).toBe(false);
    expect(await cashOf("lctr-booking")).toBe("5000.00");
  });
  it("keeps a reversal with no reason in cashReceived", async () => {
    expect(countsTowardLctr("")).toBe(true);
    expect(countsTowardLctr(null)).toBe(true);
    await kept("lctr-z", "lctr-noreason", "", at(DAY2, "16:00:00"));
  });
  it("still counts a reversal posted inside the window", async () => {
    await kept("lctr-i", "lctr-inside", "Customer changed their mind", at(DAY1, "15:00:00"));
  });
  it("keeps the prepared and filed report bytes unchanged after the booking error", async () => {
    await deal("lctr-prep", "lctr-prep", "100.00", at(DAY1, "12:00:00"));
    await deal("lctr-filed", "lctr-filed", "100.00", at(DAY1, "12:00:00"));
    await placeFiling("fil-prep", "draft", "ref-lctr-prep", { mark: "prepared", total: "100.00" });
    await placeFiling("fil-filed", "filed", "ref-lctr-filed", { mark: "filed", total: "100.00" });
    const beforePrep = await filingBytes("fil-prep");
    const beforeFiled = await filingBytes("fil-filed");
    expect(await bookingError("lctr-prep", "prep-booking")).toBeNull();
    expect(await bookingError("lctr-filed", "filed-booking")).toBeNull();
    expect(await filingBytes("fil-prep")).toBe(beforePrep);
    expect(await filingBytes("fil-filed")).toBe(beforeFiled);
    expect(await reversals("lctr-prep")).toBe(1);
    expect(await reversals("lctr-filed")).toBe(1);
  });
  it("stores the prepared flag and the filed flag on the server", async () => {
    expect(await flagRows("fil-prep")).toEqual([{ transaction_id: "lctr-prep", actor_id: SUPERVISOR }]);
    expect(await flagRows("fil-filed")).toEqual([{ transaction_id: "lctr-filed", actor_id: SUPERVISOR }]);
    const listed = await new ReportFilingService(pool).list(actor(SUPERVISOR, "supervisor"));
    const byId = Object.fromEntries(listed.filings.map((row) => [row.filingId, row.bookingErrorFlag]));
    expect(byId["fil-prep"]).toBe(PREPARED_FLAG);
    expect(byId["fil-filed"]).toBe(FILED_FLAG);
    expect(FILING_FLAG_PREPARED).toBe(PREPARED_FLAG);
    expect(FILING_FLAG_FILED).toBe(FILED_FLAG);
  });
  it("stores no flag when the deal was not in any report", async () => {
    await deal("lctr-free", "lctr-free", "100.00", at(DAY1, "12:00:00"));
    expect(await bookingError("lctr-free", "free-booking")).toBeNull();
    const found = await pool.query(
      `SELECT count(*)::int AS n FROM ledger_filing_flags g
         JOIN ledger_report_filings f ON f.filing_id = g.filing_id
        WHERE f.subject_transaction_ids @> jsonb_build_array('ref-lctr-free')`,
    );
    expect(found.rows[0].n).toBe(0);
  });
  it("stores one row per deal, and marking the same deal again does not add a row", async () => {
    await deal("lctr-2a", "lctr-2", "100.00", at(DAY1, "11:00:00"));
    await deal("lctr-2b", "lctr-2", "100.00", at(DAY1, "11:30:00"));
    await placeFiling("fil-2", "filed", ["ref-lctr-2a", "ref-lctr-2b"], { mark: "twice" });
    expect(await bookingError("lctr-2a", "twice-a")).toBeNull();
    expect(await bookingError("lctr-2b", "twice-b")).toBeNull();
    expect(await bookingError("lctr-2a", "twice-again")).toMatchObject({ code: "REVERSAL_ALREADY_EXISTS" });
    expect(await flagRows("fil-2")).toEqual([
      { transaction_id: "lctr-2a", actor_id: SUPERVISOR },
      { transaction_id: "lctr-2b", actor_id: SUPERVISOR },
    ]);
  });
  it("refuses a teller who sets the booking-error reason, and the deal stays in the total", async () => {
    await deal("lctr-t-1", "lctr-teller", "6000.00", at(DAY1, "14:00:00"));
    await deal("lctr-t-2", "lctr-teller", "5000.00", at(DAY2, "10:00:00"));
    let refused: unknown = null;
    try { await service.reverse(actor(TELLER, "teller"), "lctr-t-1", "teller-booking", BOOKING_ERROR_REASON); }
    catch (error) { refused = error; }
    expect(refused).toMatchObject({ code: "AUTHORIZATION_DENIED", message: TELLER_MSG });
    expect(await cashOf("lctr-teller")).toBe("11000.00");
    expect(await reversals("lctr-t-1")).toBe(0);
  });

  it("keeps an ordinary reversal in a prepared report and a filed report, with no flag", async () => {
    await deal("lctr-op", "lctr-ordp", "6000.00", at(DAY1, "14:00:00"));
    await deal("lctr-op2", "lctr-ordp", "5000.00", at(DAY2, "10:00:00"));
    await deal("lctr-of", "lctr-ordf", "6000.00", at(DAY1, "14:00:00"));
    await deal("lctr-of2", "lctr-ordf", "5000.00", at(DAY2, "10:00:00"));
    await placeFiling("fil-op", "draft", "ref-lctr-op", { mark: "ordinary-prepared" });
    await placeFiling("fil-of", "filed", "ref-lctr-of", { mark: "ordinary-filed" });
    const beforeP = await filingBytes("fil-op");
    const beforeF = await filingBytes("fil-of");
    await service.reverse(actor(SUPERVISOR, "supervisor"), "lctr-op", "ord-prep", "Customer changed their mind");
    await service.reverse(actor(SUPERVISOR, "supervisor"), "lctr-of", "ord-filed", "Customer changed their mind");
    expect(await cashOf("lctr-ordp")).toBe("11000.00");
    expect(await cashOf("lctr-ordf")).toBe("11000.00");
    expect(await filingBytes("fil-op")).toBe(beforeP);
    expect(await filingBytes("fil-of")).toBe(beforeF);
    const flags = await pool.query("SELECT count(*)::int AS n FROM ledger_filing_flags WHERE filing_id IN ('fil-op','fil-of')");
    expect(flags.rows[0].n).toBe(0);
  });

  it("refuses a teller booking error on a prepared report and on a filed report", async () => {
    await deal("lctr-tp", "lctr-tp", "100.00", at(DAY1, "12:00:00"));
    await deal("lctr-tf", "lctr-tf", "100.00", at(DAY1, "12:00:00"));
    await placeFiling("fil-tp", "draft", "ref-lctr-tp", { mark: "teller-p" });
    await placeFiling("fil-tf", "filed", "ref-lctr-tf", { mark: "teller-f" });
    for (const [id, key] of [["lctr-tp", "teller-prep"], ["lctr-tf", "teller-filed"]] as const) {
      let refused: unknown = null;
      try { await service.reverse(actor(TELLER, "teller"), id, key, BOOKING_ERROR_REASON); }
      catch (error) { refused = error; }
      expect(refused).toMatchObject({ code: "AUTHORIZATION_DENIED", message: TELLER_MSG });
      expect(await reversals(id)).toBe(0);
      const idem = await pool.query("SELECT count(*)::int AS n FROM ledger_idempotency WHERE idempotency_key=$1", [key]);
      expect(idem.rows[0].n).toBe(0);
    }
    const flags = await pool.query("SELECT count(*)::int AS n FROM ledger_filing_flags WHERE filing_id IN ('fil-tp','fil-tf')");
    expect(flags.rows[0].n).toBe(0);
  });

  it("rolls the flag back when the reversal fails after the insert", async () => {
    await deal("lctr-rb", "lctr-rb", "100.00", at(DAY1, "12:00:00"));
    await placeFiling("fil-rb", "draft", "ref-lctr-rb", { mark: "rollback" });
    const before = await filingBytes("fil-rb");
    await pool.query(
      `INSERT INTO ledger_till_balances (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
       VALUES ($1,$2,$3,$4,$5,'CAD',0)`,
      scope,
    );
    await pool.query(
      "INSERT INTO ledger_till_movements (transaction_id, movement_kind, currency, direction, amount, created_at) VALUES ('lctr-rb','original','CAD','in',100,now())",
    );
    expect(await bookingError("lctr-rb", "rb-booking")).toMatchObject({ code: "REVERSAL_NOT_ALLOWED" });
    const flags = await pool.query("SELECT count(*)::int AS n FROM ledger_filing_flags WHERE filing_id='fil-rb'");
    expect(flags.rows[0].n).toBe(0);
    expect(await filingBytes("fil-rb")).toBe(before);
    expect(await reversals("lctr-rb")).toBe(0);
  });

  it("stores the actor and the transaction on each booking-error deal", async () => {
    const found = await pool.query(
      "SELECT transaction_id, actor_id FROM ledger_filing_flags WHERE filing_id='fil-2' ORDER BY transaction_id",
    );
    expect(found.rows).toEqual([
      { transaction_id: "lctr-2a", actor_id: SUPERVISOR },
      { transaction_id: "lctr-2b", actor_id: SUPERVISOR },
    ]);
  });

  it("shows the filed sentence after a prepared report is filed", async () => {
    await deal("lctr-st", "lctr-st", "100.00", at(DAY1, "12:00:00"));
    await placeFiling("fil-st", "draft", "ref-lctr-st", { mark: "status" });
    expect(await bookingError("lctr-st", "st-booking")).toBeNull();
    const read = async () => {
      const listed = await new ReportFilingService(pool).list(actor(SUPERVISOR, "supervisor"));
      return listed.filings.find((row) => row.filingId === "fil-st")?.bookingErrorFlag;
    };
    expect(await read()).toBe(PREPARED_FLAG);
    await pool.query("UPDATE ledger_report_filings SET status='filed', acknowledgement_ref='ACK-fil-st' WHERE filing_id='fil-st'");
    expect(await read()).toBe(FILED_FLAG);
  });

  it("removes the flags when a draft filing is deleted", async () => {
    await deal("lctr-del", "lctr-del", "100.00", at(DAY1, "12:00:00"));
    await placeFiling("fil-del", "draft", "ref-lctr-del", { mark: "delete" });
    expect(await bookingError("lctr-del", "del-booking")).toBeNull();
    const count = async () => (await pool.query("SELECT count(*)::int AS n FROM ledger_filing_flags WHERE filing_id='fil-del'")).rows[0].n;
    expect(await count()).toBe(1);
    await pool.query("DELETE FROM ledger_report_filings WHERE filing_id='fil-del'");
    expect(await count()).toBe(0);
  });

  it("succeeds when a flag row is already stored for that deal", async () => {
    await deal("lctr-cf", "lctr-cf", "100.00", at(DAY1, "12:00:00"));
    await placeFiling("fil-cf", "filed", "ref-lctr-cf", { mark: "conflict" });
    await pool.query(
      `INSERT INTO ledger_filing_flags (filing_id, transaction_id, tenant_id, legal_entity_id, actor_id, posted_at)
       VALUES ('fil-cf','lctr-cf',$1,$2,'seeded',now())`,
      [TENANT, ENTITY],
    );
    expect(await bookingError("lctr-cf", "cf-booking")).toBeNull();
    expect(await flagRows("fil-cf")).toEqual([{ transaction_id: "lctr-cf", actor_id: "seeded" }]);
    expect(await reversals("lctr-cf")).toBe(1);
  });
});
