/* ============================================================
   STOREFRONT HOLDS ARE DECIMAL — audit Slice F.

   `rate_quotes` held customer-facing SMS amounts and the quoted
   rate as `double precision`. `rate_boards` stored buy/sell margins
   the same way. The SMS path then priced those holds with IEEE
   `*` `/`. Ledger money is `numeric(24,2)` / `numeric(24,12)` and
   Decimal; a rate a customer shows at the counter has to survive
   the same discipline.

   Existing rows are cast in place (USING). Amounts snap to 2dp,
   rates and margins to 12dp — the scales the book already uses.
   No rows are deleted. Twilio delivery is untouched.

   Idempotent on a database that already has these types: ALTER
   TYPE to the same numeric definition is a no-op.
   ============================================================ */

ALTER TABLE rate_quotes
  ALTER COLUMN have_amount TYPE numeric(24, 2)
    USING have_amount::numeric(24, 2),
  ALTER COLUMN quoted_rate TYPE numeric(24, 12)
    USING quoted_rate::numeric(24, 12),
  ALTER COLUMN receive_amount TYPE numeric(24, 2)
    USING receive_amount::numeric(24, 2);

ALTER TABLE rate_boards
  ALTER COLUMN buy_margin TYPE numeric(24, 12)
    USING buy_margin::numeric(24, 12),
  ALTER COLUMN sell_margin TYPE numeric(24, 12)
    USING sell_margin::numeric(24, 12);
