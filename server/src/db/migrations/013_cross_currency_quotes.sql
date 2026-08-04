/* ============================================================
   One deal, two foreign currencies.

   A customer walks in with dollars and wants euros. Until now the book
   made them do it twice — sell the dollars for home currency, buy the
   euros back — because a quote carried exactly one rate and the posting
   path insisted the home currency be on one side of every exchange.

   A cross is priced off TWO board rows, and a board row is home currency
   per one unit. `market_mid` can hold one of them, so it holds the side
   the deal is valued on (the incoming one) and two new columns hold both.
   They are nullable because on an ordinary deal one side IS the home
   currency and its rate is 1 by definition — a column that means "not
   applicable" is more honest than a 1 nobody chose.

   Nothing is renamed and nothing is dropped: `market_mid` keeps its
   meaning for every quote that already exists, and everything reading it
   keeps working. See docs/JURISDICTION_PACK_ARCHITECTURE.md.
   ============================================================ */

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS from_mid numeric(24,12) CHECK (from_mid IS NULL OR from_mid > 0),
  ADD COLUMN IF NOT EXISTS to_mid numeric(24,12) CHECK (to_mid IS NULL OR to_mid > 0);

/* The shape of the deal, which the two currencies and the desk's home
   currency between them already determine. `customer_cross` is the third
   one; there is no fourth. */
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_direction_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_direction_check
  CHECK (direction IN ('customer_buy_foreign', 'customer_sell_foreign', 'customer_cross'));

/* On a cross the desk is buying one currency and selling another in the
   same movement, so "we buy" and "we sell" are both true and neither is
   the answer. */
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_buy_or_sell_side_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_buy_or_sell_side_check
  CHECK (buy_or_sell_side IN ('we_buy', 'we_sell', 'we_cross'));

/* A quote's terms are frozen once it is live, and the two mids are terms:
   a cross re-priced later off one of them is a cross priced wrongly, and
   moving the mid nobody was watching is exactly how a deal gets rewritten
   between quoting and posting. The rest of this function is unchanged from
   002_quote_service.sql. */
CREATE OR REPLACE FUNCTION quote_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('active','expired','cancelled','posted','rejected') AND (
    NEW.input_amount <> OLD.input_amount OR NEW.output_amount <> OLD.output_amount OR
    NEW.market_mid <> OLD.market_mid OR NEW.customer_rate <> OLD.customer_rate OR
    NEW.from_mid IS DISTINCT FROM OLD.from_mid OR
    NEW.to_mid IS DISTINCT FROM OLD.to_mid OR
    NEW.fee_cad <> OLD.fee_cad OR NEW.spread_cad <> OLD.spread_cad OR
    NEW.rate_board_publication_id <> OLD.rate_board_publication_id OR
    NEW.market_snapshot_id IS DISTINCT FROM OLD.market_snapshot_id OR
    NEW.rate_source_type <> OLD.rate_source_type
  ) THEN RAISE EXCEPTION 'activated quote terms are immutable'; END IF;
  RETURN NEW;
END; $$;
