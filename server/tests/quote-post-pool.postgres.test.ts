/* Posting a quote commits the quote check, then asks the ledger to post
   the deal. The quote connection stayed checked out across that second
   checkout. The pool has no acquire timeout, so once every connection
   is inside a quote post that is waiting for a ledger connection, the
   server waits forever.

   The burst below is larger than the pool: twelve first posts, and
   eight replays of a deal that is already stored. On the second
   checkout, this test hits its own timeout and fails. It does not hang
   the runner. A pool left full of those waits also refuses the next
   post, one quote on its own, until the process is restarted. After
   the quote connection is returned before the ledger checkout, every
   first post lands once, every replay is that same deal, and one
   more post on that same pool completes. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { ensureLedgerPrincipal } from "../src/ledger/principal.js";
import type { LedgerActor } from "../src/ledger/service.js";
import { QuoteService } from "../src/quotes/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const POOL_MAX = 4;
const POST_COUNT = 12;
const REPLAY_COUNT = 8;
const TENANT = "tnt-quote-pool";
const ENTITY = "le-quote-pool";
const BRANCH = "br-quote-pool";
const WORKSPACE = "ws-quote-pool";
const TILL = "till-quote-pool";
const CUSTOMER = "customer-quote-pool";
const BOARD = "board-quote-pool";
const SNAPSHOT = "snap-quote-pool";

let handle: DbHandle;
let setup: pg.Pool;

const actor = (): LedgerActor => ({
  userId: "quote-pool-teller",
  tenantId: TENANT,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  workspaceId: WORKSPACE,
  tillId: TILL,
  role: "teller",
  authorizedBranchIds: [BRANCH],
});

const request = (amount: string) => ({
  customerId: CUSTOMER,
  from: "CAD",
  to: "USD",
  inputAmount: amount,
  feeCad: "4.00",
  direction: "customer_buy_foreign" as const,
});

postgres("quote post returns its connection before the ledger checkout", () => {
  const made: string[] = [];
  let storedDeal = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    setup = new pg.Pool({ connectionString: url });
    const transactions = setup.query(
      "SELECT transaction_id FROM ledger_transactions WHERE tenant_id = $1",
      [TENANT],
    );
    await setup.query(
      `DELETE FROM ledger_cost_lot_consumption
        WHERE event_id IN (SELECT event_id FROM ledger_cost_events WHERE tenant_id = $1)`,
      [TENANT],
    );
    await setup.query("DELETE FROM ledger_cost_lots WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_cost_events WHERE tenant_id = $1", [TENANT]);
    const ids = await transactions;
    const transactionIds = ids.rows.map((row) => row.transaction_id);
    if (transactionIds.length) {
      await setup.query(
        "DELETE FROM ledger_till_movements WHERE transaction_id = ANY($1::text[])",
        [transactionIds],
      );
      await setup.query(
        "DELETE FROM ledger_journal_entries WHERE transaction_id = ANY($1::text[])",
        [transactionIds],
      );
    }
    await setup.query(
      `DELETE FROM quote_events
        WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id = $1)`,
      [TENANT],
    );
    await setup.query("DELETE FROM quotes WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_audit_events WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_idempotency WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_transactions WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_till_sessions WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_till_balances WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_customers WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM ledger_principals WHERE tenant_id = $1", [TENANT]);
    await setup.query("DELETE FROM rate_boards WHERE id = $1", [BOARD]);
    await setup.query("DELETE FROM market_rates WHERE id = $1", [SNAPSHOT]);
    await setup.query("DELETE FROM branches WHERE id = $1", [BRANCH]);
    await setup.query("DELETE FROM legal_entities WHERE id = $1", [ENTITY]);
    await setup.query("DELETE FROM tenants WHERE id = $1", [TENANT]);

    await setup.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [TENANT, "Quote pool"]);
    await setup.query(
      `INSERT INTO legal_entities
        (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ($1, $2, 'Quote pool', 'CAD', 'pack-ca-v1', 1)`,
      [ENTITY, TENANT],
    );
    await setup.query(
      "INSERT INTO branches (id, tenant_id, legal_entity_id, name) VALUES ($1, $2, $3, 'Quote pool desk')",
      [BRANCH, TENANT, ENTITY],
    );
    const who = actor();
    await ensureLedgerPrincipal(setup, who);
    await setup.query(
      `INSERT INTO ledger_customers
        (customer_id, tenant_id, legal_entity_id, branch_id, workspace_id, name, risk, id_status)
       VALUES ($1, $2, $3, $4, $5, 'Pool Customer', 'Normal', 'verified')`,
      [CUSTOMER, TENANT, ENTITY, BRANCH, WORKSPACE],
    );
    for (const [currency, amount] of [["CAD", "50000.00"], ["USD", "50000.00"]] as const) {
      await setup.query(
        `INSERT INTO ledger_till_balances
          (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [TENANT, ENTITY, BRANCH, WORKSPACE, TILL, currency, amount],
      );
    }
    await setup.query(
      `INSERT INTO ledger_till_sessions
        (session_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
         session_number, business_date, status, opened_by, opened_at)
       VALUES ('session-quote-pool', $1, $2, $3, $4, $5, 1, current_date, 'open', $6, now())`,
      [TENANT, ENTITY, BRANCH, WORKSPACE, TILL, who.userId],
    );
    await setup.query(
      "INSERT INTO market_rates (id, provider, mids, fetched_at) VALUES ($1, 'test', '{\"USD\":1.4}', now())",
      [SNAPSHOT],
    );
    await setup.query(
      `INSERT INTO rate_boards
        (id, tenant_id, legal_entity_id, branch_id, buy_margin, sell_margin, board_rows, market_snapshot_id, published_at)
       VALUES ($1, $2, $3, $4, 0.02, 0.03, '{"USD":{"mid":1.4,"show":true}}', $5, now())`,
      [BOARD, TENANT, ENTITY, BRANCH, SNAPSHOT],
    );

    const quotes = new QuoteService(setup);
    for (let n = 0; n < POST_COUNT + 2; n += 1) {
      const created = await quotes.create(who, request((100 + n).toFixed(2)));
      made.push(created.quoteId);
    }
    const first = await quotes.post(
      who,
      made[0]!,
      "quote-pool-stored",
      "Personal travel",
      "Employment income",
    );
    storedDeal = first.transactionId;
  }, 120_000);

  afterAll(async () => {
    await setup?.end();
    await handle?.close();
    delete process.env.DATABASE_URL;
  });

  it("posts 12 quotes once, replays one deal, then posts one more", async () => {
    const burst = new pg.Pool({
      connectionString: url,
      max: POOL_MAX,
      connectionTimeoutMillis: 0,
    });
    try {
      const quotes = new QuoteService(burst);
      const who = actor();
      const fresh = made.slice(1, POST_COUNT + 1);
      const laterId = made[POST_COUNT + 1]!;
      const [posted, replayed] = await Promise.all([
        Promise.all(fresh.map((quoteId, n) =>
          quotes.post(who, quoteId, `quote-pool-post-${n}`, "Personal travel", "Employment income"),
        )),
        Promise.all(Array.from({ length: REPLAY_COUNT }, () =>
          quotes.post(who, made[0]!, "quote-pool-stored", "Personal travel", "Employment income"),
        )),
      ]);
      expect(posted).toHaveLength(POST_COUNT);
      expect(new Set(posted.map((deal) => deal.transactionId)).size).toBe(POST_COUNT);
      expect(new Set(posted.map((deal) => deal.quoteId)).size).toBe(POST_COUNT);
      replayed.forEach((deal) => {
        expect(deal.transactionId).toBe(storedDeal);
        expect(deal.quoteId).toBe(made[0]);
      });
      const later = await quotes.post(
        who,
        laterId,
        "quote-pool-after",
        "Personal travel",
        "Employment income",
      );
      expect(later.quoteId).toBe(laterId);
      expect(later.transactionId).toBeTruthy();
      expect(posted.some((deal) => deal.transactionId === later.transactionId)).toBe(false);
      const deals = await setup.query(
        "SELECT count(*) AS n FROM ledger_transactions WHERE tenant_id = $1",
        [TENANT],
      );
      const lines = await setup.query(
        `SELECT count(*) AS n FROM ledger_journal_entries
          WHERE transaction_id IN (SELECT transaction_id FROM ledger_transactions WHERE tenant_id = $1)`,
        [TENANT],
      );
      const quotesPosted = await setup.query(
        "SELECT count(*) AS n FROM quotes WHERE tenant_id = $1 AND status = 'posted'",
        [TENANT],
      );
      expect(deals.rows[0].n).toBe(String(POST_COUNT + 2));
      expect(lines.rows[0].n).toBe(String((POST_COUNT + 2) * 5));
      expect(quotesPosted.rows[0].n).toBe(String(POST_COUNT + 2));
    } finally {
      await burst.end();
    }
  }, 20_000);
});
