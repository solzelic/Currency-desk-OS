-- Early Access v2.1, the SAM call (CD-180, CD-181).
--
-- enquiry_call_consents: consent to be called, kept as evidence. The
-- number (E.164), the exact sentence agreed to, the client's address and
-- the country Cloudflare reports for it, the browser, and when. A stop is
-- another row. Code only ever inserts here, the same as
-- enquiry_contact_consents; the latest row for an application is its
-- answer.
--
-- enquiries.sam_call_at / sam_call_zone: when the applicant asked SAM to
-- call, in UTC, and the zone the calling hours were read in.
CREATE TABLE IF NOT EXISTS enquiry_call_consents (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  event text NOT NULL,
  phone text NOT NULL,
  consent_text text,
  ip_address text,
  ip_country text,
  user_agent text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_call_consents_idx ON enquiry_call_consents (enquiry_id, at);
ALTER TABLE enquiry_call_consents DROP CONSTRAINT IF EXISTS enquiry_call_consents_event_check;
ALTER TABLE enquiry_call_consents ADD CONSTRAINT enquiry_call_consents_event_check CHECK (event IN ('consent', 'stop'));
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS sam_call_at timestamptz;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS sam_call_zone text;
