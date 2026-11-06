/* ============================================================
   The Bank of Canada's daily rate, on file by date (CD-146, GitHub
   #631, slice 1 of the CTO's fix).

   PCMLTFR s.125: the 3,000 and 10,000 CAD lines are measured at the
   Bank of Canada's published rate, not the shop's board rate. Nothing
   in this product knew that rate. This is the source: the bank's Valet
   feed (group FX_RATES_DAILY, Canadian dollars per one unit), pulled on
   a timer and stored by date, and one reader the gate will use. The
   gate itself is the next slice; nothing reads this table yet.

   The reader answers the latest published rate for a currency, which
   is the rate in effect (Compliance, 3 Nov), and says when that rate is
   older than the last business day in Toronto: the feed failed, or the
   bank stopped publishing that currency. A rate for the dollar itself
   is one. A book not kept in dollars has no Bank of Canada rate.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { bocHomePerUnit } from "../src/ledger/boc-daily.js";
import { parseValetDaily, syncBocDailyRates, type BocPull } from "../src/rates/boc.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, handle: DbHandle;

/* The feed's shape, cut down: one row per date, one value per series.
   The rouble stopped in 2019, so its latest row is years old. */
const VALET = {
  terms: { url: "https://www.bankofcanada.ca/terms/" },
  seriesDetail: {
    FXUSDCAD: { label: "USD/CAD", description: "Daily average exchange rate of the US dollar in Canadian dollars." },
    FXEURCAD: { label: "EUR/CAD", description: "Daily average exchange rate of the euro in Canadian dollars." },
    FXRUBCAD: { label: "RUB/CAD", description: "Daily average exchange rate of the Russian rouble in Canadian dollars." },
  },
  observations: [
    { d: "2019-12-31", FXRUBCAD: { v: "0.02090" } },
    { d: "2026-11-04", FXUSDCAD: { v: "1.3952" }, FXEURCAD: { v: "1.6048" } },
    { d: "2026-11-05", FXUSDCAD: { v: "1.3977" }, FXEURCAD: { v: "" }, FXZZZCAD: { v: "9" } },
  ],
};

const todayToronto = async () => String((await pool.query("SELECT (timezone('America/Toronto', now()))::date::text AS d")).rows[0].d);
const daysAgo = async (n: number) => String((await pool.query("SELECT ((timezone('America/Toronto', now()))::date - $1::int)::text AS d", [n])).rows[0].d);
const read = async (unit: string, home = "CAD") => {
  const client = await pool.connect();
  try { return await bocHomePerUnit(client, unit, home); } finally { client.release(); }
};

postgres("the Bank of Canada daily rate", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => { await handle.close(); await pool.end(); });
  beforeEach(async () => { await pool.query("DELETE FROM boc_daily_rates"); });

  it("reads the feed into one row per date and currency, and skips what is not a rate", () => {
    const rows = parseValetDaily(VALET);
    expect(rows).toEqual([
      { rateDate: "2019-12-31", currency: "RUB", cadPerUnit: "0.02090" },
      { rateDate: "2026-11-04", currency: "USD", cadPerUnit: "1.3952" },
      { rateDate: "2026-11-04", currency: "EUR", cadPerUnit: "1.6048" },
      { rateDate: "2026-11-05", currency: "USD", cadPerUnit: "1.3977" },
      { rateDate: "2026-11-05", currency: "ZZZ", cadPerUnit: "9" },
    ]);
  });

  it("stores the pull by date, once per date and currency, and a second pull updates rather than doubles", async () => {
    const pull: BocPull = { fetchedAt: new Date(), rows: parseValetDaily(VALET) };
    const first = await syncBocDailyRates(pool, async () => pull);
    expect(first).toMatchObject({ ok: true, stored: 5 });
    const again = await syncBocDailyRates(pool, async () => ({ ...pull, rows: [{ rateDate: "2026-11-05", currency: "USD", cadPerUnit: "1.4000" }] }));
    expect(again).toMatchObject({ ok: true, stored: 1 });
    const stored = await pool.query("SELECT rate_date::text AS d, currency, cad_per_unit::text AS r FROM boc_daily_rates ORDER BY rate_date, currency");
    expect(stored.rowCount).toBe(5);
    expect(stored.rows.find((r) => r.d === "2026-11-05" && r.currency === "USD")?.r).toBe("1.400000000000");
  });

  it("a failed pull is reported, not thrown, and stores nothing", async () => {
    const failed = await syncBocDailyRates(pool, async () => { throw new Error("valet is down"); });
    expect(failed).toMatchObject({ ok: false });
    expect(failed.detail).toContain("valet is down");
    expect((await pool.query("SELECT count(*)::int AS n FROM boc_daily_rates")).rows[0].n).toBe(0);
  });

  it("answers the latest published rate, in dollars per unit, with its date", async () => {
    const today = await todayToronto();
    const earlier = await daysAgo(1);
    await pool.query("INSERT INTO boc_daily_rates (rate_date,currency,cad_per_unit,fetched_at) VALUES ($1,'USD',1.3952,now()),($2,'USD',1.3977,now())", [earlier, today]);
    const usd = await read("usd");
    expect(usd).not.toBeNull();
    expect(usd!.rate.toFixed(4)).toBe("1.3977");
    expect(usd!.rateDate).toBe(today);
    expect(usd!.stale).toBe(false);
    expect(usd!.source).toBe("boc_daily");
  });

  it("says when the rate on file is older than the last business day, and still answers it", async () => {
    const old = await daysAgo(10);
    await pool.query("INSERT INTO boc_daily_rates (rate_date,currency,cad_per_unit,fetched_at) VALUES ($1,'EUR',1.6048,now())", [old]);
    const eur = await read("EUR");
    expect(eur).not.toBeNull();
    expect(eur!.rate.toFixed(4)).toBe("1.6048");
    expect(eur!.stale).toBe(true);
  });

  it("has no rate for a currency the bank does not publish, for a book not kept in dollars, and one for the dollar itself", async () => {
    const today = await todayToronto();
    await pool.query("INSERT INTO boc_daily_rates (rate_date,currency,cad_per_unit,fetched_at) VALUES ($1,'USD',1.3977,now())", [today]);
    expect(await read("PHP")).toBeNull();
    expect(await read("USD", "GBP")).toBeNull();
    const cad = await read("CAD");
    expect(cad!.rate.toFixed(1)).toBe("1.0");
    expect(cad!.stale).toBe(false);
  });
});
