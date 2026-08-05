/* ============================================================
   The desk trades what the desk trades.

   Until migration 020 it traded four things, everywhere, forever:
   `z.enum(["CAD", "USD", "EUR", "GBP"])` in five places in
   `ledger/routes.ts`, backed by a `type Currency` union of the same four
   in five service files. Nothing in the schema needed it —
   `ledger_till_balances.currency` is a `char(3)` and the packs ship six
   home currencies — and the cost of it was specific: this product's
   largest feature is remittance, the corridors it seeds are the
   Philippines, India, China, Mexico and the UAE, and a Toronto desk
   running the Philippine corridor was refused at the route when it tried
   to put a peso in a till.

   What is proved here, in the order it matters:

     1. A PESO REACHES THE DRAWER. The headline. Written so it fails
        against the old enum, which rejected it with a 422 at the route
        before any service saw it.
     2. Removing a ceiling did not install a smaller one. The first
        version of the resolver fell back to the home currency alone
        when a desk had stated nothing — twenty-three tests failed and
        every one of them was right to. A desk that has stated nothing
        trades anything the ledger can carry.
     3. A desk that HAS stated its set gets exactly that, and a refusal
        that names the set rather than a list compiled into the binary.
     4. Minor units are ISO 4217, not two-for-everything. There is no
        such thing as ¥1,234.56, and a three-decimal dinar is refused
        out loud rather than truncated into a numeric(24,2) column.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  asCurrencyCode,
  carriable,
  fixedIn,
  minorUnits,
  parseMoney,
  resolveDeskCurrencies,
  roundTo,
  tradeable,
} from "../src/ledger/currencies.js";
import { LedgerError } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;

const TENANT = "tnt-currencies";
const ENTITY = "le-currencies";
const BRANCH = "br-currencies";

async function withClient<T>(run: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

const resolve = () =>
  withClient((client) =>
    resolveDeskCurrencies(client, {
      legalEntityId: ENTITY,
      branchId: BRANCH,
      homeCurrency: "CAD",
    }),
  );

const deskStates = (codes: string[] | null) =>
  pool.query("UPDATE legal_entities SET traded_currencies=$2 WHERE id=$1", [
    ENTITY,
    codes,
  ]);

/* ------------------------------------------------------------
   Minor units need no database — ISO 4217 is a fact about the
   currency, not about the desk, which is exactly why it is not a
   column somebody can be wrong in.
   ------------------------------------------------------------ */
describe("minor units are the currency's, not two for everything", () => {
  it("knows the zero-decimal currencies", () => {
    expect(minorUnits("JPY")).toBe(0);
    expect(minorUnits("KRW")).toBe(0);
    expect(minorUnits("VND")).toBe(0);
    expect(minorUnits("CLP")).toBe(0);
  });

  it("knows the ordinary ones, including the ones nobody listed", () => {
    for (const code of ["CAD", "USD", "EUR", "GBP", "PHP", "INR", "MXN", "ZWG"]) {
      expect(minorUnits(code), code).toBe(2);
    }
  });

  it("refuses a three-decimal currency out loud rather than truncating it", () => {
    const answer = carriable("KWD");
    expect(answer.ok).toBe(false);
    /* The reason has to say what would happen, because the alternative
       — a numeric(24,2) column quietly eating the third place on every
       dinar — is invisible until somebody reconciles a year of them. */
    if (!answer.ok) expect(answer.reason).toMatch(/three decimal places/i);
    expect(carriable("BHD").ok).toBe(false);
    expect(carriable("JOD").ok).toBe(false);
    expect(carriable("USD").ok).toBe(true);
  });

  it("will not accept an amount the currency cannot be paid in", () => {
    /* There is no such thing as ¥1,234.56. The old validator took it,
       because it took two decimal places for everything. */
    expect(() => parseMoney("1234.56", "JPY", "Payout")).toThrow(LedgerError);
    expect(() => parseMoney("1234.56", "JPY", "Payout")).toThrow(/no minor unit/i);
    expect(parseMoney("1234", "JPY", "Payout").toString()).toBe("1234");

    // and still holds the ordinary rule for everything else
    expect(() => parseMoney("1.234", "USD", "Amount")).toThrow(/2 decimal places/i);
    expect(parseMoney("1.23", "USD", "Amount").toString()).toBe("1.23");
  });

  it("rounds a computed figure to what a teller can count out", () => {
    expect(roundTo(new Decimal("1234.56"), "JPY").toString()).toBe("1235");
    expect(fixedIn(new Decimal("1234.56"), "JPY")).toBe("1235");
    expect(fixedIn(new Decimal("1234.5"), "USD")).toBe("1234.50");
  });

  it("recognises a currency code, and nothing else", () => {
    expect(asCurrencyCode(" php ")).toBe("PHP");
    expect(asCurrencyCode("php")).toBe("PHP");
    expect(asCurrencyCode("PESOS")).toBeNull();
    expect(asCurrencyCode("")).toBeNull();
    expect(asCurrencyCode(42)).toBeNull();
  });
});

postgres("what a desk is permitted to hold", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
      [TENANT],
    );
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,jurisdiction,home_currency)
       VALUES ($1,$2,'Currency Desk','x','CAD') ON CONFLICT (id) DO NOTHING`,
      [ENTITY, TENANT],
    );
    await pool.query(
      `INSERT INTO branches (id,tenant_id,legal_entity_id,name)
       VALUES ($1,$2,$3,'Counter') ON CONFLICT (id) DO NOTHING`,
      [BRANCH, TENANT, ENTITY],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM rate_boards WHERE branch_id=$1", [BRANCH]);
    await pool.query("DELETE FROM branches WHERE id=$1", [BRANCH]);
    await pool.query("DELETE FROM legal_entities WHERE id=$1", [ENTITY]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [TENANT]);
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => deskStates(null));

  /* ---- the regression that matters ---- */

  it("lets a desk that has stated nothing trade anything the ledger carries", async () => {
    const desk = await resolve();
    expect(desk.stated).toBeNull();
    /* THE POINT. Removing a four-currency ceiling must not install a
       one-currency one. Every desk in the world has this column NULL. */
    for (const code of ["PHP", "INR", "CNY", "MXN", "AED", "JPY", "USD"]) {
      expect(tradeable(desk, code), code).toEqual({ ok: true });
    }
  });

  it("still refuses what the ledger genuinely cannot hold, stated or not", async () => {
    const desk = await resolve();
    const answer = tradeable(desk, "KWD");
    expect(answer.ok).toBe(false);
    /* Not "this desk does not trade it" — the ledger cannot carry it,
       which is a different sentence and a different fix. */
    if (!answer.ok) expect(answer.reason).toMatch(/three decimal places/i);
  });

  /* ---- and what a stated set actually does ---- */

  it("gives a desk that named its currencies exactly those", async () => {
    await deskStates(["USD", "PHP", "INR"]);
    const desk = await resolve();
    expect(desk.stated).toEqual(["CAD", "INR", "PHP", "USD"]);
    expect(tradeable(desk, "PHP")).toEqual({ ok: true });
    expect(tradeable(desk, "CAD")).toEqual({ ok: true });

    const refused = tradeable(desk, "EUR");
    expect(refused.ok).toBe(false);
    /* The refusal names the desk's own set. The old one named a list
       compiled into the binary, which no shop could act on. */
    if (!refused.ok) {
      expect(refused.reason).toContain("EUR");
      expect(refused.reason).toContain("CAD, INR, PHP, USD");
    }
  });

  it("never lets a stated set include something the ledger cannot carry", async () => {
    await deskStates(["USD", "KWD", "PHP"]);
    const desk = await resolve();
    /* The dinar is dropped from the set rather than sitting in it as a
       currency that half-works. `carriable` is what explains why. */
    expect(desk.stated).toEqual(["CAD", "PHP", "USD"]);
    expect(tradeable(desk, "KWD").ok).toBe(false);
  });

  it("keeps the home currency in the set whatever the owner typed", async () => {
    await deskStates(["USD"]);
    const desk = await resolve();
    expect(desk.stated).toContain("CAD");
    expect(tradeable(desk, "CAD")).toEqual({ ok: true });
  });

  /* ---- the suggestion, which constrains nothing ---- */

  it("suggests what the branch's board already quotes when nobody has stated a set", async () => {
    await pool.query(
      `INSERT INTO rate_boards
         (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,board_order)
       VALUES ('rb-currencies',$1,$2,$3,0.015,0.015,$4,$5)
       ON CONFLICT (id) DO UPDATE SET board_rows=EXCLUDED.board_rows`,
      [
        TENANT,
        ENTITY,
        BRANCH,
        JSON.stringify({
          USD: { mid: 0.73, show: true },
          PHP: { mid: 0.024, show: true },
        }),
        JSON.stringify(["USD", "PHP"]),
      ],
    );
    const desk = await resolve();
    expect(desk.suggested).toEqual(["CAD", "PHP", "USD"]);
    /* A suggestion for a dropdown, and nothing more. The board says what
       this desk quotes; it does not get to say what it may hold. */
    expect(desk.stated).toBeNull();
    expect(tradeable(desk, "EUR")).toEqual({ ok: true });
  });

  it("refuses a set the database itself would not accept", async () => {
    await expect(deskStates(["usd"])).rejects.toThrow(/traded_currencies_check/);
    await expect(deskStates(["US"])).rejects.toThrow(/traded_currencies_check/);
    /* NULL means unstated. An empty array would mean "trades nothing",
       which is not a thing anybody means. */
    await expect(deskStates([])).rejects.toThrow(/traded_currencies_check/);
  });
});
