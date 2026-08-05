/* ============================================================
   A peso reaches the drawer.

   One claim, proved at the HTTP surface rather than against a service,
   because the thing that used to refuse it WAS the HTTP surface.
   `POST /api/ledger/till-movements` validated its currency with
   `z.enum(["CAD", "USD", "EUR", "GBP"])`, so a Toronto desk running the
   Philippine corridor — the product's own seeded corridor, its largest
   feature — got a 400 from Zod before any ledger code ran. There was no
   service to fix and no error a shop could act on.

   Every assertion here fails against that enum. That is the point of
   the file: it is written to be a regression test for a ceiling, not a
   description of a feature.

   The second half proves the ceiling was not merely moved. A desk that
   has stated its currencies gets a refusal that names its own set; a
   desk that has stated nothing is not restricted at all, because a
   restriction nobody stated is not a restriction. And a three-decimal
   currency is still refused — out loud, with the reason — because the
   money columns hold two places and truncating a dinar silently is a
   worse answer than saying no.
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

async function cookie(staffId = "r.haddad") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value,
  };
}

const scope = [
  DEMO.tenantId,
  DEMO.legalEntityId,
  DEMO.branchId,
  DEMO.workspaceId,
  "till-01",
];

/* WHICH TILL EVERY REQUEST HERE IS FOR, stated — exactly as the browser's
   Backend client states it on every call it makes.

   Without the header the ledger routes fall back to "the only workspace
   at this branch", which is not a thing on a desk with two tills. Another
   suite adds till-11 to the demo branch and leaves it there, so a test
   that omits this passes or returns SCOPE_DENIED depending on which file
   ran first — which is exactly the accident this file caught in
   client-records.postgres.test.ts and then repeated. */
const headers = { "x-workspace-id": DEMO.workspaceId };

/** A float in, through the desk's own cash rail. */
async function float(currency: string, amount: string, key: string) {
  return app.inject({
    method: "POST",
    url: "/api/ledger/till-movements",
    cookies: await cookie(),
    headers,
    payload: {
      idempotencyKey: key,
      direction: "in",
      currency,
      amount,
      counterpartyType: "bank",
      counterpartyRef: "corridor-settlement",
      reason: "Float for the Philippine corridor",
    },
  });
}

/* The three principals this file signs in as, ensured rather than
   assumed.

   `ledger_principals` is TRUNCATEd and re-seeded by several other suites,
   and the whole server suite shares one database — so a file that leans
   on `seed()` having left its principals behind passes alone and returns
   403 in a full run. That is not a flake to retry; it is a fixture that
   was never stated. */
/* The demo desk on its own pack, restated before each test.

   `resolveDeskCurrencies` answers in the desk's HOME currency, which comes
   from the jurisdiction pack — and another suite in this shared database
   repoints this entity at a GBP pack and leaves it there. A test that
   assumed CAD passed or failed on file ordering. Restated rather than
   read, because these assertions are about a Canadian desk holding pesos
   and the pack is a precondition of that, not an incidental. Set to
   exactly what seed() creates, so nothing downstream is left worse off. */
async function demoOnItsOwnPack() {
  await pool.query(
    `UPDATE legal_entities
        SET home_currency='CAD', jurisdiction_pack_id='pack-ca-v1',
            jurisdiction_pack_version=1
      WHERE id=$1`,
    [DEMO.legalEntityId],
  );
}

async function ensurePrincipals() {
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES
      ($1||':a.singh',$1,$2,$3,$4,$5,'teller',$6),
      ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager',$6),
      ($1||':j.masri',$1,$2,$3,$4,$5,'administrator',$6)
     ON CONFLICT (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id)
     DO UPDATE SET role=EXCLUDED.role, authorized_branch_ids=EXCLUDED.authorized_branch_ids`,
    [...scope, JSON.stringify([DEMO.branchId])],
  );
}

const deskTrades = (codes: string[] | null) =>
  pool.query("UPDATE legal_entities SET traded_currencies=$2 WHERE id=$1", [
    DEMO.legalEntityId,
    codes,
  ]);

postgres("the currencies a desk may actually hold", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await seed(handle.db);
    app = await buildApp(handle.db);
    await app.ready();
  });

  afterAll(async () => {
    await deskTrades(null);
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE ledger_operational_cash_movements,ledger_till_sessions,ledger_audit_events,ledger_till_movements,ledger_idempotency,ledger_till_balances CASCADE",
    );
    await ensurePrincipals();
    await demoOnItsOwnPack();
    await deskTrades(null);
    await pool.query(
      `INSERT INTO ledger_till_balances
         (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
       VALUES ($1,$2,$3,$4,$5,'CAD','25000.00')`,
      scope,
    );
    await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: await cookie(),
      headers,
      payload: {},
    });
  });

  /* ---- the headline ---- */

  it("takes a peso float into the till, which the four-currency enum refused outright", async () => {
    const moved = await float("PHP", "50000.00", "php-float-1");
    expect(moved.statusCode).toBe(201);
    expect(moved.json().balances.PHP).toBe("50000.00");

    /* And it is on the book, not merely in a response. */
    const held = await pool.query(
      "SELECT available_amount FROM ledger_till_balances WHERE till_id='till-01' AND currency='PHP'",
    );
    expect(held.rows[0]?.available_amount).toBe("50000.00");
  });

  it("takes the rest of the product's own seeded corridors too", async () => {
    /* INR, CNY, MXN, AED. Every corridor this product ships with, and
       not one of them could be held in a drawer. */
    for (const [index, code] of ["INR", "CNY", "MXN", "AED"].entries()) {
      const moved = await float(code, "1000.00", `corridor-${code}-${index}`);
      expect(moved.statusCode, `${code} was refused`).toBe(201);
      expect(moved.json().balances[code]).toBe("1000.00");
    }
  });

  /* ---- and the ceiling was not just moved ---- */

  it("leaves a desk that has stated nothing unrestricted", async () => {
    const moved = await float("ZAR", "500.00", "zar-float");
    expect(moved.statusCode).toBe(201);
  });

  it("refuses by name once a desk has stated its currencies", async () => {
    await deskTrades(["USD", "PHP"]);
    const allowed = await float("PHP", "1000.00", "stated-php");
    expect(allowed.statusCode).toBe(201);

    const refused = await float("ZAR", "500.00", "stated-zar");
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("CURRENCY_NOT_TRADED");
    /* The refusal names the desk's OWN set, which is a sentence somebody
       at the counter can act on. The enum's refusal named four
       currencies compiled into the binary. */
    expect(refused.json().message).toContain("ZAR");
    expect(refused.json().message).toContain("CAD, PHP, USD");
  });

  it("still refuses a currency the ledger's columns cannot hold", async () => {
    /* Two decimals on purpose: a three-decimal AMOUNT is refused by the
       amount validator with a 400 and says nothing about the currency.
       What is being proved here is the currency gate, so the amount is
       one the route accepts. */
    const refused = await float("KWD", "100.00", "kwd-float");
    /* Two decimal places is what `numeric(24,2)` holds. A dinar has
       three, and quietly dropping the third on every deal is the kind of
       loss nobody finds for a year. */
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("UNSUPPORTED_CURRENCY");
    expect(refused.json().message).toMatch(/three decimal places/i);
  });

  it("refuses something that is not a currency at all, at the route", async () => {
    const refused = await float("PESOS", "100.00", "not-a-code");
    expect(refused.statusCode).toBe(400);
  });

  it("counts and closes on a currency the desk stopped trading", async () => {
    /* A desk that drops a currency from its set must still be able to
       count out what it holds. Gating a close on the traded set would
       strand real cash in a drawer — which is why `assertTradeable` is
       on the paths that bring money IN and on none of the ones that
       account for what is already there. */
    expect((await float("PHP", "50000.00", "php-before")).statusCode).toBe(201);
    await deskTrades(["USD"]);

    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: await cookie(),
      headers,
      payload: {
        idempotencyKey: "count-php",
        counts: { CAD: "25000.00", PHP: "50000.00" },
      },
    });
    expect(counted.statusCode).toBe(201);
    expect(counted.json().latestCounts.PHP).toMatchObject({
      counted: "50000.00",
      variance: "0.00",
    });
  });


/* ============================================================
   And the owner can say so themselves.

   The refusals above tell a teller to "add it in Settings" — a sentence
   that has to be true. This is the route behind it: administrator-only,
   audited, and reversible to "no set stated" rather than to an empty one.
   ============================================================ */
/* ONE lifecycle for the whole file.

   This block used to open its own database handle, re-seed, and build a
   second app — then close all three — while the block above had already
   done and undone exactly that. The server suite shares one database, and
   two sets of setup/teardown against it inside a single file left
   `ledger_principals` in a state that failed this file AND
   client-records.postgres.test.ts, whichever ran second. Nested, so the
   connection is opened once and closed once. */
describe("an owner states the desk's currencies", () => {
  beforeEach(async () => {
    await ensurePrincipals();
    await demoOnItsOwnPack();
    await deskTrades(null);
  });

  const put = async (currencies: string[] | null, staffId = "j.masri") =>
    app.inject({
      method: "PUT",
      url: "/api/ledger/desk-currencies",
      cookies: await cookie(staffId),
      headers,
      payload: { currencies },
    });

  it("reads as unrestricted until somebody states a set", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-currencies",
      cookies: await cookie(),
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().stated).toBeNull();
    expect(read.json().home).toBe("CAD");
  });

  it("stores what the owner named, home included and sorted", async () => {
    const saved = await put(["php", " usd ", "PHP"]);
    expect(saved.statusCode).toBe(200);
    /* Normalised, de-duplicated, and the home currency is in the set
       whatever the owner typed — it is not optional for a desk to deal
       in the currency it keeps its books in. */
    expect(saved.json().stated).toEqual(["CAD", "PHP", "USD"]);
    expect(saved.json().minorUnits).toEqual({});
  });

  it("hands the question back on null, rather than storing an empty set", async () => {
    await put(["USD"]);
    const cleared = await put(null);
    expect(cleared.statusCode).toBe(200);
    /* Null restores "nobody has stated one" — which leaves the desk able
       to deal in anything the ledger carries. An empty set would mean
       "trades nothing", which is not a state any shop is in. */
    expect(cleared.json().stated).toBeNull();
  });

  it("refuses a currency the ledger cannot carry, at the moment it is named", async () => {
    const refused = await put(["USD", "KWD"]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("UNSUPPORTED_CURRENCY");
    /* Told here rather than discovered later by a teller who cannot take
       a dinar with a customer waiting. */
    expect(refused.json().message).toMatch(/three decimal places/i);
  });

  it("refuses a set with nothing in it but the home currency", async () => {
    const refused = await put(["CAD"]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/at least one currency besides CAD/i);
  });

  it("refuses something that is not a currency code", async () => {
    const refused = await put(["USD", "pesos"]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/not a currency code/i);
  });

  it("is the owner's, and a teller is refused it", async () => {
    const refused = await put(["USD"], "a.singh");
    expect(refused.statusCode).toBe(403);
    /* And nothing was written on the way to being refused. */
    const row = await pool.query(
      "SELECT traded_currencies FROM legal_entities WHERE id=$1",
      [DEMO.legalEntityId],
    );
    expect(row.rows[0].traded_currencies).toBeNull();
  });

  it("writes an audit row naming both sides, and the cash left behind", async () => {
    await pool.query(
      `INSERT INTO ledger_till_balances
         (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
       VALUES ($1,$2,$3,$4,$5,'PHP','50000.00')
       ON CONFLICT (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency)
       DO UPDATE SET available_amount='50000.00'`,
      scope,
    );
    /* Counted, not cleared: `ledger_audit_events` is append-only by
       trigger and a test that deletes from it is testing a database that
       is not the one shipping. */
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action='desk.currencies.change'",
    );
    expect((await put(["USD"])).statusCode).toBe(200);

    const audit = await pool.query(
      `SELECT actor_id, reason FROM ledger_audit_events
        WHERE action='desk.currencies.change'
        ORDER BY created_at DESC LIMIT 1`,
    );
    const after = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action='desk.currencies.change'",
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    expect(audit.rows[0].reason).toContain("any the ledger carries");
    expect(audit.rows[0].reason).toContain("CAD, USD");
    /* The fact somebody will actually be looking for: the desk just
       stopped trading a currency it is still holding. Not derivable from
       the two sets on their own. */
    expect(audit.rows[0].reason).toContain("still holding PHP");

    await pool.query(
      "DELETE FROM ledger_till_balances WHERE currency='PHP' AND till_id='till-01'",
    );
  });
});
});
