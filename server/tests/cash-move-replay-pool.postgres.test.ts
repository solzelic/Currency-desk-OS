/* A cash move that loses the idempotency unique index has already
   rolled its own transaction back, and it still holds the connection.
   Reading the winner used to check out a second connection. The pool
   has no acquire timeout.

   The winner here is a transaction on another pool, so every
   connection in the small pool is a loser. The burst is larger than
   that pool. On the second checkout, this test hits its own timeout
   and fails. It does not hang the runner. After the replay reads on
   the loser's own connection, every call returns that one movement
   and no second movement is written. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { ensureLedgerPrincipal } from "../src/ledger/principal.js";
import type { LedgerActor } from "../src/ledger/service.js";
import { TillControlService } from "../src/ledger/till-control.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const POOL_MAX = 4;
const RACE_COUNT = 8;
const RUN = randomUUID().slice(0, 8);
const TENANT = `tnt-cash-${RUN}`;
const ENTITY = `le-cash-${RUN}`;
const BRANCH = `br-cash-${RUN}`;
const WORKSPACE = `ws-cash-${RUN}`;
const TILL = `till-cash-${RUN}`;
const SESSION = `session-cash-${RUN}`;
const KEY = `cash-pool-${RUN}`;
const MOVEMENT = `cash-move-${RUN}`;

let handle: DbHandle;
let setup: pg.Pool;

const actor = (): LedgerActor => ({
  userId: "cash-pool-supervisor",
  tenantId: TENANT,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  workspaceId: WORKSPACE,
  tillId: TILL,
  role: "supervisor",
  authorizedBranchIds: [BRANCH],
});

const input = {
  idempotencyKey: KEY,
  direction: "in" as const,
  currency: "CAD",
  amount: "25.00",
  counterpartyType: "other" as const,
  counterpartyRef: "bank-deposit",
  reason: "Opening float from the bank",
};

postgres("cash-move replay uses the rolled-back connection", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    setup = new pg.Pool({ connectionString: url });
    await setup.query("INSERT INTO tenants (id, name) VALUES ($1, 'Cash pool')", [TENANT]);
    await setup.query(
      `INSERT INTO legal_entities
        (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ($1, $2, 'Cash pool', 'CAD', 'pack-ca-v1', 1)`,
      [ENTITY, TENANT],
    );
    await setup.query(
      "INSERT INTO branches (id, tenant_id, legal_entity_id, name) VALUES ($1, $2, $3, 'Cash pool desk')",
      [BRANCH, TENANT, ENTITY],
    );
    const who = actor();
    await ensureLedgerPrincipal(setup, who);
    await setup.query(
      `INSERT INTO ledger_till_balances
        (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
       VALUES ($1, $2, $3, $4, $5, 'CAD', 100.00)`,
      [TENANT, ENTITY, BRANCH, WORKSPACE, TILL],
    );
    await setup.query(
      `INSERT INTO ledger_till_sessions
        (session_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
         session_number, business_date, status, opened_by, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, current_date, 'open', $7, now())`,
      [SESSION, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, who.userId],
    );
  }, 120_000);

  afterAll(async () => {
    await setup?.end();
    await handle?.close();
    delete process.env.DATABASE_URL;
  });

  it("replays 8 conflicting cash moves on a 4-connection pool", async () => {
    const holder = await setup.connect();
    const burst = new pg.Pool({
      connectionString: url,
      max: POOL_MAX,
      connectionTimeoutMillis: 0,
    });
    let committed = false;
    const service = TillControlService.prototype as unknown as {
      replayMovement(
        client: pg.PoolClient,
        who: LedgerActor,
        movement: typeof input,
      ): Promise<{ movement: { movementId: string } } | null>;
    };
    const originalReplay = service.replayMovement;
    let replayHits = 0;
    try {
      await holder.query("BEGIN");
      await holder.query(
        `INSERT INTO ledger_operational_cash_movements
          (movement_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
           session_id, direction, currency, amount, counterparty_type,
           counterparty_ref, reason, actor_id, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())`,
        [
          MOVEMENT, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, SESSION,
          input.direction, input.currency, input.amount, input.counterpartyType,
          input.counterpartyRef, input.reason, actor().userId, KEY,
        ],
      );
      const tills = new TillControlService(burst);
      /* The early read returns this movement too, once the winner has
         committed. Counting the calls is what shows the loser went
         through replayMovement, which is the branch a 422 never reaches. */
      service.replayMovement = async function (this: TillControlService, ...args) {
        replayHits += 1;
        return originalReplay.apply(this, args);
      };
      const raced = Promise.all(
        Array.from({ length: RACE_COUNT }, () => tills.moveCash(actor(), input)),
      );
      const deadline = Date.now() + 5_000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const found = await setup.query(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND state = 'active' AND wait_event_type = 'Lock'`,
        );
        waiting = Number(found.rows[0].n);
        if (waiting >= POOL_MAX) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBeGreaterThanOrEqual(POOL_MAX);
      await holder.query("COMMIT");
      committed = true;
      const results = await raced;
      expect(results).toHaveLength(RACE_COUNT);
      results.forEach((result) => {
        expect(result.movement.movementId).toBe(MOVEMENT);
        expect(result.movement.direction).toBe("in");
        expect(result.movement.currency).toBe("CAD");
        expect(result.movement.amount).toBe("25.00");
        expect(result.movement.actorId).toBe(actor().userId);
        expect(result.balances.CAD).toBe("100.00");
      });
      const stored = await setup.query(
        `SELECT count(*) AS n FROM ledger_operational_cash_movements
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [TENANT, KEY],
      );
      expect(stored.rows[0].n).toBe("1");
      /* Four connections were inside the race. Each of those lost the
         unique index and read the winner back. The ones still queued
         see the committed row on the first read, so they do not. */
      expect(replayHits).toBe(POOL_MAX);
    } finally {
      service.replayMovement = originalReplay;
      if (!committed) await holder.query("ROLLBACK");
      holder.release();
      await burst.end();
    }
  }, 20_000);
});
