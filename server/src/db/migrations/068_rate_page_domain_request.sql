-- Rates v2.5, Take it further: a shop's request to put its rate page on its
-- own domain. For now a person on the team points the domain; the request
-- also goes to the team's inbox (an enquiry of kind 'contact'). This holds
-- what the desk shows while it waits: {domain, registrar, at, by,
-- reference}. Null is no request. The owner sends and cancels it
-- (POST/DELETE /api/rate-page/domain-request); both are audited.
ALTER TABLE shop_rate_pages ADD COLUMN IF NOT EXISTS domain_request jsonb;
