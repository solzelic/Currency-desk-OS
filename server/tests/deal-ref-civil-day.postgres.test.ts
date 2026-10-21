/* A CD- reference takes its date from toISOString, which is the UTC
   day. 00:04 IDT on 21 Oct 2026 is 21:04 UTC on 20 Oct, so the deal
   is named CD-261020. The branch is still on 21 Oct. The same stamp
   is the date in an obligation reference.

   The process stays able to run in any zone. These instants are
   absolute, and the expected stamp is the branch's civil day. */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const JERUSALEM = "Asia/Jerusalem";
const TORONTO = "America/Toronto";
/* 00:04 IDT on 2026-10-21. Israel is on IDT (UTC+3) until 25 Oct. */
const JUST_AFTER = "2026-10-20T21:04:00.000Z";
/* 23:55 IDT the evening before, nine minutes earlier and the previous
   Jerusalem day. UTC has not rolled, so both instants are 20 Oct in UTC. */
const PREVIOUS_EVENING = "2026-10-20T20:55:00.000Z";
/* 23:55 IDT on 2026-10-21. UTC names that same day. */
const LATE_JERUSALEM = "2026-10-21T20:55:00.000Z";
/* 23:55 EDT on 2026-10-21. UTC has already rolled to the 22nd. */
const LATE_TORONTO = "2026-10-22T03:55:00.000Z";

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
let customerId: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (!c) throw new Error("sign-in did not set a session cookie");
  return { cdos_session: c.value };
};

function utcStamp(at: string): string {
  return new Date(at).toISOString().slice(2, 10).replace(/-/g, "");
}

postgres("a deal reference uses the branch's civil day", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await pool.query(
      "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
    );
    await seed(handle.db);
    await pool.query(
      "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.73) ON CONFLICT DO NOTHING",
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId],
    );
    app = await buildApp(handle.db);
    const owner = await login("j.masri");
    const headers = { "x-workspace-id": DEMO.workspaceId };
    expect((await app.inject({
      method: "POST",
      url: "/api/ledger/opening-balances",
      cookies: owner,
      headers,
      payload: { balances: { CAD: "25000.00", USD: "4000.00" } },
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: owner,
      headers,
    })).statusCode).toBe(201);
    const customer = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies: owner,
      headers,
      payload: { name: "Walk-in", risk: "normal", idStatus: "verified" },
    });
    expect(customer.statusCode, customer.body).toBe(201);
    customerId = customer.json().customerId as string;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (handle) await handle.close();
    if (pool) await pool.end();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function login(staffId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
    });
    expect(res.statusCode, res.body).toBe(200);
    return cookieOf(res);
  }

  async function dealRef(input: { zone: string; at: string; key: string }) {
    await pool.query("UPDATE branches SET timezone=$1 WHERE id=$2", [input.zone, DEMO.branchId]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(input.at));
    const owner = await login("j.masri");
    const deal = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: owner,
      headers: { "x-workspace-id": DEMO.workspaceId },
      payload: {
        idempotencyKey: input.key,
        customerId,
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "4.00",
        purpose: "Travel",
        sourceOfFunds: "Employment income",
        thirdParty: false,
      },
    });
    expect(deal.statusCode, deal.body).toBe(201);
    return deal.json().transactionRef as string;
  }

  it("stamps 00:04 IDT as 21 Oct, and two deals at that instant differ", async () => {
    expect(utcStamp(JUST_AFTER)).toBe("261020");
    const first = await dealRef({ zone: JERUSALEM, at: JUST_AFTER, key: "ref-j0004-a" });
    const second = await dealRef({ zone: JERUSALEM, at: JUST_AFTER, key: "ref-j0004-b" });
    expect(first).toMatch(/^CD-261021-[0-9a-f]{6}$/);
    expect(second).toMatch(/^CD-261021-[0-9a-f]{6}$/);
    expect(first).not.toBe(second);
  });

  it("stamps 11:55 pm IDT as that same 21 Oct", async () => {
    expect(utcStamp(LATE_JERUSALEM)).toBe("261021");
    const ref = await dealRef({ zone: JERUSALEM, at: LATE_JERUSALEM, key: "ref-j2355" });
    expect(ref).toMatch(/^CD-261021-[0-9a-f]{6}$/);
  });

  it("stamps 11:55 pm in Toronto as 21 Oct", async () => {
    expect(utcStamp(LATE_TORONTO)).toBe("261022");
    const ref = await dealRef({ zone: TORONTO, at: LATE_TORONTO, key: "ref-t2355" });
    expect(ref).toMatch(/^CD-261021-[0-9a-f]{6}$/);
  });

  it("keeps the two sides of Jerusalem midnight on different days", async () => {
    expect(utcStamp(PREVIOUS_EVENING)).toBe("261020");
    expect(utcStamp(JUST_AFTER)).toBe("261020");
    const evening = await dealRef({ zone: JERUSALEM, at: PREVIOUS_EVENING, key: "ref-boundary-eve" });
    const morning = await dealRef({ zone: JERUSALEM, at: JUST_AFTER, key: "ref-boundary-morn" });
    expect(evening).toMatch(/^CD-261020-[0-9a-f]{6}$/);
    expect(morning).toMatch(/^CD-261021-[0-9a-f]{6}$/);
    expect(evening.slice(0, 10)).not.toBe(morning.slice(0, 10));
    expect(evening).not.toBe(morning);
  });
});
