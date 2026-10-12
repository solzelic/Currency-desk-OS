/* ============================================================
   A close has to name every currency the drawer holds.

   The count sheet used to offer chips only for a fixed bill table
   (CAD, USD, EUR, GBP, and five more). A till holding yen had a
   balance and no chip, so the close was never sent. The server
   already refused a partial count, but the refusal did not say
   which currency was missing.

   Yen are whole units. A dinar has three places, and the columns
   hold two: an amount that needs the third place is refused rather
   than rounded. "125.000" fits and is stored as "125.00". KWD is
   inserted here because the float route still refuses to take a
   dinar in — a row that is already in the drawer must still be
   countable, or the day cannot be closed.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;

const scope = [
  DEMO.tenantId,
  DEMO.legalEntityId,
  DEMO.branchId,
  DEMO.workspaceId,
  "till-01",
];

async function cookie(staffId = "r.haddad") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

async function reset() {
  await pool.query(
    "TRUNCATE ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_till_balances,ledger_till_balance_generations CASCADE",
  );
  for (const [currency, value] of [
    ["CAD", "1000.00"],
    ["JPY", "50000.00"],
    ["KWD", "125.00"],
  ] as const) {
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, value],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-held',$1,$2,$3,$4,$5,1,current_date,'open',$1||':r.haddad',now())`,
    scope,
  );
}

const book = async (cookies: Record<string, string>) =>
  (
    await app.inject({
      method: "GET",
      url: "/api/ledger/till-balances",
      cookies,
    })
  ).json() as {
    balanceGeneration?: string;
    balances: Record<string, string>;
    minorUnits?: Record<string, number>;
  };

const close = (cookies: Record<string, string>, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/till-sessions/session-held/close",
    cookies,
    payload: body,
  });

postgres("a till close counts every currency the drawer holds", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await reset();
  });

  it("closes a drawer holding yen and dinars, in each currency's own places", async () => {
    const manager = await cookie();
    const held = await book(manager);
    expect(held.minorUnits).toEqual({ JPY: 0, KWD: 3 });

    const closed = await close(manager, {
      idempotencyKey: "close-jpy-kwd",
      counts: { CAD: "1000.00", JPY: "50000", KWD: "125.000" },
      note: "Yen and dinars counted",
      balanceGeneration: held.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().session.status).toBe("closed");

    const after = await book(manager);
    expect(after.balances.CAD).toBe("1000.00");
    expect(after.balances.JPY).toBe("50000.00");
    expect(after.balances.KWD).toBe("125.00");
    expect(
      (
        await pool.query(
          "SELECT status FROM ledger_till_sessions WHERE session_id='session-held'",
        )
      ).rows[0].status,
    ).toBe("closed");
  });

  it("refuses a close that skips one currency, and names it", async () => {
    const manager = await cookie();
    const held = await book(manager);
    const refused = await close(manager, {
      idempotencyKey: "close-missing-jpy",
      counts: { CAD: "1000.00", KWD: "125.000" },
      note: "Yen not counted",
      balanceGeneration: held.balanceGeneration,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().code).toBe("INCOMPLETE_TILL_COUNT");
    expect(refused.json().message).toBe("Count JPY before closing.");
    expect((await book(manager)).balances).toEqual(held.balances);
    expect(
      (
        await pool.query(
          "SELECT status FROM ledger_till_sessions WHERE session_id='session-held'",
        )
      ).rows[0].status,
    ).toBe("open");
  });

  it("refuses a dinar count the columns would have to round", async () => {
    const manager = await cookie();
    const held = await book(manager);
    const refused = await close(manager, {
      idempotencyKey: "close-kwd-third-place",
      counts: { CAD: "1000.00", JPY: "50000", KWD: "125.001" },
      note: "A fil that does not fit",
      balanceGeneration: held.balanceGeneration,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toContain("KWD");
    expect(refused.json().message).toMatch(/drop a place/i);
    expect((await book(manager)).balances.KWD).toBe("125.00");
    expect(
      (
        await pool.query(
          "SELECT status FROM ledger_till_sessions WHERE session_id='session-held'",
        )
      ).rows[0].status,
    ).toBe("open");
  });
});
