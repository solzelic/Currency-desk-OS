-- The Bank of Canada's daily exchange rate, on file by date (CD-146,
-- GitHub #631). PCMLTFR s.125: the 3,000 and 10,000 CAD lines are
-- measured at the bank's published rate, not the shop's board rate.
--
-- One row per date and currency, Canadian dollars per one unit, as the
-- bank's Valet feed states it (server/src/rates/boc.ts pulls it). The
-- gate reads the latest row for a currency (server/src/ledger/boc-daily.ts)
-- and says when it is older than the last business day. A ledger table,
-- beside nbs_middle_rates; not run on PGlite, which has no ledger.
CREATE TABLE IF NOT EXISTS boc_daily_rates (
  rate_date date NOT NULL,
  currency text NOT NULL,
  cad_per_unit numeric(24,12) NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_date, currency)
);
CREATE INDEX IF NOT EXISTS boc_daily_rates_currency_idx ON boc_daily_rates (currency, rate_date DESC);
