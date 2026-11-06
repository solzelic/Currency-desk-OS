/* ============================================================
   The Bank of Canada's daily exchange rate (CD-146, GitHub #631).

   PCMLTFR s.125: the 3,000 and 10,000 CAD lines are measured at the
   bank's published rate, not the shop's board rate. This pulls that
   rate from the bank's Valet feed (group FX_RATES_DAILY, Canadian
   dollars per one unit, one value per business day at about 16:30 in
   Toronto) and stores it by date in boc_daily_rates. The gate reads it
   through server/src/ledger/boc-daily.ts.

   The feed answers one row per date, with a value for each series that
   has one that day: `{ observations: [{ d: "2026-11-05", FXUSDCAD:
   { v: "1.3977" }, ... }] }`. A series the bank stopped (the rouble, in
   2019) keeps its last date, which the reader then calls stale.

   It is the shop's compliance rate, not its price. market_rates is the
   board's feed and nothing here touches it.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";

export const BOC_VALET_URL = "https://www.bankofcanada.ca/valet/observations/group/FX_RATES_DAILY/json?recent=5";
/* The bank publishes once a business day. Four looks a day is enough
   to have it within hours and costs the bank nothing to speak of. */
export const BOC_SYNC_MS = 6 * 60 * 60 * 1000;
const BOC_FAILURE_RETRY_MS = 30 * 60 * 1000;

export type BocRow = { rateDate: string; currency: string; cadPerUnit: string };
export type BocPull = { fetchedAt: Date; rows: BocRow[] };

/* One row per date and currency from the feed's shape, in the feed's
   order. A series that is not FX<CCY>CAD, or a value that is not a
   positive number, is not a rate and is left out. */
export function parseValetDaily(body: unknown): BocRow[] {
  const observations = (body as { observations?: unknown })?.observations;
  if (!Array.isArray(observations)) return [];
  const rows: BocRow[] = [];
  for (const observation of observations) {
    if (!observation || typeof observation !== "object") continue;
    const record = observation as Record<string, unknown>;
    const rateDate = typeof record.d === "string" ? record.d : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) continue;
    for (const [series, cell] of Object.entries(record)) {
      const match = /^FX([A-Z]{3})CAD$/.exec(series);
      if (!match) continue;
      const raw = (cell as { v?: unknown })?.v;
      if (typeof raw !== "string" || raw.trim() === "") continue;
      let value: Decimal;
      try {
        value = new Decimal(raw.trim());
      } catch {
        continue;
      }
      if (!value.isFinite() || !value.gt(0)) continue;
      rows.push({ rateDate, currency: match[1]!, cadPerUnit: raw.trim() });
    }
  }
  return rows;
}

export async function fetchBocDailyRates(): Promise<BocPull> {
  const res = await fetch(BOC_VALET_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Bank of Canada Valet HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const rows = parseValetDaily(body);
  if (!rows.length) throw new Error("Bank of Canada Valet answered no rates");
  return { fetchedAt: new Date(), rows };
}

/* One pull, stored. A row already on file for that date and currency is
   updated, so a second pull of the same day doubles nothing. Never
   throws: a failed pull is reported, and the rows on file stay. */
export async function syncBocDailyRates(
  pool: pg.Pool,
  fetcher: () => Promise<BocPull> = fetchBocDailyRates,
): Promise<{ ok: boolean; stored: number; detail: string }> {
  try {
    const pull = await fetcher();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of pull.rows) {
        await client.query(
          `INSERT INTO boc_daily_rates (rate_date, currency, cad_per_unit, fetched_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (rate_date, currency)
           DO UPDATE SET cad_per_unit = EXCLUDED.cad_per_unit, fetched_at = EXCLUDED.fetched_at`,
          [row.rateDate, row.currency, row.cadPerUnit, pull.fetchedAt],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const latest = pull.rows.reduce((max, row) => (row.rateDate > max ? row.rateDate : max), "");
    return { ok: true, stored: pull.rows.length, detail: `${pull.rows.length} rates, latest ${latest}` };
  } catch (error) {
    return { ok: false, stored: 0, detail: error instanceof Error ? error.message : "unknown error" };
  }
}

/* The timer. The first look is at boot; a failed look tries again in
   half an hour rather than waiting the whole gap. */
export function startBocSync(
  pool: pg.Pool,
  gapMs: number = BOC_SYNC_MS,
  fetcher: () => Promise<BocPull> = fetchBocDailyRates,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  const tick = async () => {
    if (stopped) return;
    const result = await syncBocDailyRates(pool, fetcher);
    if (stopped) return;
    console.log(`[boc-sync] ${result.ok ? "ok" : "FAILED"} - ${result.detail}`);
    schedule(result.ok ? gapMs : BOC_FAILURE_RETRY_MS);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
