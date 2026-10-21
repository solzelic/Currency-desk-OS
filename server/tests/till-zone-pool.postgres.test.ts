/* Opening a till, and handing one over, read branches.timezone while
   their transaction already holds a connection. That read used to
   check out a second connection from the same pool. The pool has no
   acquire timeout, so once every connection is inside that
   transaction the server waits forever.

   The burst below is larger than the pool. On the pool read, this
   test hits its own timeout and fails. It does not hang the runner.
   After the read moves onto the transaction's own connection, every
   open and every handover finishes, on the branch's civil day. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { civilTodayInZone } from "../src/civil-date.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { TillControlService } from "../src/ledger/till-control.js";
import { ensureLedgerPrincipal } from "../src/ledger/principal.js";
import type { LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const ZONE = "Asia/Jerusalem";
const POOL_MAX = 4;
const OPEN_COUNT = 12;
const HAND_COUNT = 12;
const TENANT = "tnt-zone-pool";
const ENTITY = "le-zone-pool";
const BRANCH = "br-zone-pool";

let handle: DbHandle;
let setup: pg.Pool;

const actor = (userId: string, n: number): LedgerActor => ({
  userId,
  tenantId: TENANT,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  workspaceId: `ws-zone-pool-${n}`,
  tillId: `till-zone-pool-${n}`,
  role: "teller",
  authorizedBranchIds: [BRANCH],
});

postgres("till open and handover share the transaction connection", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    setup = new pg.Pool({ connectionString: url });
    await setup.query("DELETE FROM ledger_till_counts WHERE batch_id IN (SELECT batch_id FROM ledger_till_count_batches WHERE tenant_id = $1)", [TENANT]);
    await setup.query("DELETE FROM ledger_till_count_batches WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_till_sessions WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_till_balances WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_principals WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM branches WHERE id = $1", [BRANCH]);
    await setup.query("DELETE FROM legal_entities WHERE id = $1", [ENTITY]);
    await setup.query("DELETE FROM tenants WHERE id = $1", [TENANT]);
    await setup.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [TENANT, "Zone pool"]);
    await setup.query("INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)", [ENTITY, TENANT, "Zone pool entity"]);
    await setup.query(
      "INSERT INTO branches (id, tenant_id, legal_entity_id, name, timezone) VALUES ($1, $2, $3, $4, $5)",
      [BRANCH, TENANT, ENTITY, "Jerusalem", ZONE],
    );
    const tills = new TillControlService(setup);
    for (let n = 0; n < OPEN_COUNT + HAND_COUNT; n += 1) {
      const outgoing = actor(`zone-pool-out-${n}`, n);
      const incoming = actor(`zone-pool-in-${n}`, n);
      await ensureLedgerPrincipal(setup, outgoing);
      await ensureLedgerPrincipal(setup, incoming);
      await setup.query(
        `INSERT INTO ledger_till_balances
          (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
         VALUES ($1, $2, $3, $4, $5, 'CAD', 100.00)`,
        [TENANT, ENTITY, BRANCH, outgoing.workspaceId, outgoing.tillId],
      );
      if (n < HAND_COUNT) {
        const opened = await tills.open(outgoing);
        expect(opened.session?.status).toBe("open");
        expect(opened.session?.openedBy).toBe(outgoing.userId);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await setup?.end();
    await handle?.close();
    delete process.env.DATABASE_URL;
  });

  it("finishes 24 opens and handovers on a 4-connection pool", async () => {
    const burst = new pg.Pool({
      connectionString: url,
      max: POOL_MAX,
      connectionTimeoutMillis: 0,
    });
    try {
      const tills = new TillControlService(burst);
      const day = civilTodayInZone(new Date(), ZONE);
      const opens = Array.from({ length: OPEN_COUNT }, (_, n) => actor(`zone-pool-in-${HAND_COUNT + n}`, HAND_COUNT + n));
      const hands = Array.from({ length: HAND_COUNT }, (_, n) => actor(`zone-pool-in-${n}`, n));
      const [opened, handed] = await Promise.all([
        Promise.all(opens.map((who) => tills.open(who))),
        Promise.all(hands.map((who, n) => tills.handover(who, `zone-pool-hand-${n}`, { CAD: "100.00" }))),
      ]);
      expect(opened).toHaveLength(OPEN_COUNT);
      expect(handed).toHaveLength(HAND_COUNT);
      opened.forEach((result, n) => {
        expect(result.session?.status).toBe("open");
        expect(result.session?.timezone).toBe(ZONE);
        expect(result.session?.businessDate).toBe(day);
        expect(result.session?.sessionNumber).toBe(1);
        expect(result.session?.openedBy).toBe(opens[n]!.userId);
      });
      handed.forEach((result, n) => {
        expect(result.session?.status).toBe("open");
        expect(result.session?.timezone).toBe(ZONE);
        expect(result.session?.businessDate).toBe(day);
        expect(result.session?.sessionNumber).toBe(2);
        expect(result.session?.openedBy).toBe(hands[n]!.userId);
      });
    } finally {
      await burst.end();
    }
  }, 20_000);
});
