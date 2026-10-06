/* The currency a published rate board is quoted in.

   A board mid is home currency per one unit of the row. When the owner
   moves the book, those mids are still the old home. Leaving them up
   would price the next quote in the wrong currency without anyone
   changing a number.

   This column records which home the mids were published in. It does
   not convert them and it does not delete history. A publication whose
   currency is not the book's current home is not the live board: the
   desk publishes again. Rows that predate the column are labelled with
   the entity's home at the time this runs, which is the currency they
   were actually quoted in. */
ALTER TABLE rate_boards
  ADD COLUMN IF NOT EXISTS home_currency char(3);

UPDATE rate_boards AS rb
   SET home_currency = upper(btrim(le.home_currency::text))
  FROM legal_entities AS le
 WHERE le.id = rb.legal_entity_id
   AND rb.home_currency IS NULL
   AND le.home_currency IS NOT NULL
   AND btrim(le.home_currency::text) <> ''
   AND upper(btrim(le.home_currency::text)) ~ '^[A-Z]{3}$';
