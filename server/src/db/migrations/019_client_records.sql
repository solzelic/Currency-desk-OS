/* ============================================================
   A customer is a person, not the spelling of their name.

   Every customer file this product has ever held lived in a browser, in
   `localStorage` under `cdos_clients_v1`, as one object keyed BY THE
   CUSTOMER'S NAME. Four things followed from that single decision, and
   together they are the reason the product could not be given to a real
   shop.

   TWO PEOPLE CALLED DAVID CHEN WERE ONE FILE. A key is an identity
   claim, and a name is not one. The second David Chen to walk in
   inherited the first one's date of birth, the first one's passport
   number, the first one's risk rating and the first one's transaction
   history — and the desk, looking at a screen that said "David Chen ·
   Verified", had no way to see it had happened. The reverse was just as
   bad: correcting "Jonh" to "John" MOVED the key, and everything filed
   under the old spelling stopped resolving.

   NOTHING ABOUT A CUSTOMER WAS QUERYABLE OR PROVABLE. `ledger_customers`
   carried four columns — an external reference, a name, a risk word and
   an ID status word. Date of birth, address, ID number, ID expiry,
   screening outcome, the scans themselves: all of it existed only in one
   browser profile on one counter machine. A desk is required to retain
   these and to produce them on demand for five years, and it could not
   produce them at all.

   TWO COUNTERS WERE TWO SHOPS. Each browser held its own copy, so the
   customer identified at till 1 was a stranger at till 2.

   AND IT WAS THE BIGGEST THING IN A BOUNDED STORE. Passport scans, as
   base64 data URLs, inside the same four-megabyte document that carries
   the desk's settings and its book. A desk that hit the ceiling stopped
   saving ANYTHING — see os-src/cdos-persist.js.

   ---- WHAT THIS MIGRATION CANNOT FIX ----

   The merge has already happened. Where a desk's blob has one "David
   Chen" holding two people's papers, this migration cannot separate
   them, and it does not try: splitting on a guess would invent a
   customer who never existed and hand half a transaction history to
   each. What it does instead is give every record a stable identity from
   this moment on, carry the old name forward as an ALIAS so nothing
   already filed is orphaned, and set `possible_duplicate` on any record
   whose shape suggests more than one person so that a human can look.
   Silence was the old behaviour and it is the thing being removed.

   ---- THE LINE THIS SCHEMA IS BUILT AROUND ----

   The columns below are grouped into two blocks, IDENTIFYING and SIGNAL,
   and the grouping is the most important thing in this file.

     IDENTIFYING  legal name, date of birth, ID numbers, scans, the exact
                  street address. This is the data that, on its own, is
                  enough to BE somebody. It belongs to the desk that
                  collected it, under the consent that desk obtained, and
                  it never leaves.

     SIGNAL       verification status, risk rating, screening outcome and
                  what matched, region rather than street, the dates. It
                  describes a person without being enough to be them.

   The owner intends, later and deliberately, to let desks learn that a
   person is known to the network — screened, a hit, high risk — without
   ID numbers or scans ever leaving the desk holding them. That is not
   built here and must not be: it needs a legal basis (consent captured
   at onboarding, purpose limitation, minimisation) and that is the
   owner's decision, not this change's.

   What this change owes the future is that the decision remains
   POSSIBLE. The migration that untangles PII from signal after the fact,
   across every desk's live data, is the migration nobody ever gets to
   do. So the split is structural from day one, the classification is
   executable rather than documentary (see
   server/src/clients/classification.ts, and the test that asserts no
   identifying column can reach a signal projection), and the whole
   thing is written down in docs/CLIENT_RECORDS.md.

   ---- SCOPE: THE LEGAL ENTITY, NOT THE BRANCH ----

   `desk_clients` is keyed on (tenant_id, legal_entity_id). Not branch,
   not workspace. One shop's customer is that shop's customer at every
   counter it has and at every location it ever opens. Multi-branch is
   not the priority now, but this is the one decision that decides
   whether it costs a rewrite later, and it is being made here.

   `ledger_customers`, which the posting path uses, stays workspace-
   scoped — the ledger's row is a per-till counter record and the posting
   path is not being restructured. It gains a `client_id` instead, so the
   ledger's row and the desk's record become two views of one person
   rather than a third concept.
   ============================================================ */

/* ---- the person ------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS desk_clients (
  /* Never a name, and never derived from one. A rename is an UPDATE to a
     column; it does not move a row, orphan a history or collide with
     anybody. That sentence is the entire point of this table. */
  client_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  legal_entity_id text NOT NULL REFERENCES legal_entities(id),

  /* ---- IDENTIFYING ---------------------------------------------------
     Enough, on its own or in combination, to be this person. Never
     leaves the desk that collected it. */
  display_name text NOT NULL,
  date_of_birth date,
  address_line text,
  city text,
  postal_code text,
  email text,
  phone text,
  /* Free text a teller types about a specific human being. Classified
     identifying because it cannot be classified at all: "sister of the
     woman at 14 Elm who came in Tuesday" is identifying, and there is no
     way to know in advance that somebody wrote it. */
  notes text,

  /* ---- SIGNAL ---------------------------------------------------------
     Describes the person without being enough to be them. This is the
     side a network could one day carry. Nothing here is sent anywhere
     today. */
  kind text NOT NULL DEFAULT 'individual'
    CHECK (kind IN ('individual','business')),
  /* Region, not street. A country and a province are a jurisdiction —
     which is what a risk judgement is actually made against — where a
     house number is a doorstep somebody can be found at. */
  region text,
  country text,
  occupation text,
  risk_rating text NOT NULL DEFAULT 'normal'
    CHECK (risk_rating IN ('low','normal','medium','high')),
  /* What the desk actually knows about this identity, as opposed to what
     it has typed in. `identified` means papers are on file; `verified`
     means a provider authenticated them. The distinction is the one the
     screens already draw and the one an examiner cares about. */
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','identified','verified','expired')),
  verified_at timestamptz,
  /* The result of a sanctions / PEP screen, and what it matched on. A
     list name and a category — never the matched record itself, which
     would be a third party's identifying data sitting in this desk's
     row. */
  screening_outcome text
    CHECK (screening_outcome IS NULL OR screening_outcome IN ('clear','hit','pending')),
  screening_matched text,
  screened_at timestamptz,

  /* ---- business clients ----
     Incorporation details are a public record in every jurisdiction
     shipped here, which is why they sit on the signal side while an
     individual's date of birth does not. */
  incorporation_date date,
  incorporation_jurisdiction text,
  nature_of_business text,
  /* The human being who acts for the company. Identifying: it is a
     person's name and their job. */
  contact_name text,
  contact_title text,

  /* ---- collision, made visible ----
     `name_key` is the normalised name. It is NOT unique and must never
     become unique — two customers legitimately share a name, and that is
     the whole defect being fixed. It exists so the desk can be TOLD
     about a collision at the moment it happens instead of silently
     merging into one.

     Generated rather than written by the application, because a
     normalisation the server and the browser each implement is a
     normalisation they will eventually disagree about. */
  name_key text GENERATED ALWAYS AS
    (lower(regexp_replace(btrim(display_name), '\s+', ' ', 'g'))) STORED,

  /* Set by the migration below on any record whose SHAPE suggests it is
     more than one person — two documents of one type carrying different
     numbers, or a name shared with another record in the same entity.
     Never set silently: `duplicate_reason` says what was noticed, in
     words somebody can act on. Nothing is split and nothing is merged
     further on the strength of it. */
  possible_duplicate boolean NOT NULL DEFAULT false,
  duplicate_reason text,

  /* ---- the network hash, reserved and empty -------------------------
     Written by nothing. Read by nothing. It is here because adding a
     nullable column now costs nothing and adding it later costs a
     migration over live PII, which is the migration that never happens.

     What it should be over, when somebody decides to build matching:
     a salted one-way digest of (date of birth, normalised legal name)
     for an individual, or (incorporation jurisdiction, registration
     number) for a business — never an ID number, because an ID number
     digest is a lookup table anybody can build. The salt has to be
     shared across desks for two desks to agree, and shared salt is
     exactly the design question that needs the legal basis this change
     deliberately does not assume.

     `network_match_hash_version` is what stops this column committing to
     anything: the input definition may change completely, and rows
     written under an old definition stay identifiable rather than
     silently comparing false. */
  network_match_hash text,
  network_match_hash_version integer,

  /* Who last touched it, and when. A record an examiner reads is a
     record somebody is answerable for. */
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS desk_clients_entity_idx
  ON desk_clients (tenant_id, legal_entity_id, name_key);
CREATE INDEX IF NOT EXISTS desk_clients_entity_updated_idx
  ON desk_clients (tenant_id, legal_entity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS desk_clients_network_hash_idx
  ON desk_clients (network_match_hash)
  WHERE network_match_hash IS NOT NULL;

/* ---- every name this person has been known by ------------------------

   Including the one the browser used as a key. That row is what stops
   this migration orphaning anybody: a transaction, a filing or a report
   that still names "Jonh Smith" resolves through the alias to the client
   whose display name is now "John Smith", and keeps resolving forever.

   A separate table rather than an array because it is looked up by
   value, and because each alias carries WHERE it came from — a reader a
   year from now needs to tell "this is the name the old browser store
   used" apart from "this customer also trades as". */
CREATE TABLE IF NOT EXISTS desk_client_aliases (
  alias_id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES desk_clients(client_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  /* IDENTIFYING — it is a name. */
  alias text NOT NULL,
  alias_key text GENERATED ALWAYS AS
    (lower(regexp_replace(btrim(alias), '\s+', ' ', 'g'))) STORED,
  /* legacy_name_key — the key the browser store used, carried forward
     former_name    — replaced by a rename on this record
     also_known_as  — a name the customer gave the desk */
  alias_kind text NOT NULL DEFAULT 'also_known_as'
    CHECK (alias_kind IN ('legacy_name_key','former_name','also_known_as')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS desk_client_aliases_unique
  ON desk_client_aliases (client_id, alias_key, alias_kind);
CREATE INDEX IF NOT EXISTS desk_client_aliases_lookup_idx
  ON desk_client_aliases (tenant_id, legal_entity_id, alias_key);

/* ---- what identifies them, kept apart from what describes them -------

   Its own table, and this is not tidiness.

   A person legitimately holds several documents — a passport, a driving
   licence, a permanent-resident card — and they expire on different days
   and are issued by different governments. The blob modelled this as a
   `ids[]` array beside a set of top-level `idType` / `idNum` columns,
   which meant the "primary" ID was structurally different from the
   others and every screen had to special-case it.

   The deeper reason is the split. Everything on this table is on the
   identifying side of the line, with two named exceptions, so the
   boundary is a table boundary: a signal projection of a customer joins
   nothing here at all. That is a much harder thing to get wrong by
   accident than a column somebody forgot to exclude. */
CREATE TABLE IF NOT EXISTS desk_client_identity_documents (
  document_id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES desk_clients(client_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,

  /* SIGNAL — what KIND of document, not which document. "This person was
     identified by a passport" carries no more about them than "this
     person was identified". */
  doc_type text NOT NULL,

  /* IDENTIFYING */
  doc_number text,
  issuing_jurisdiction text,
  issued_on date,

  /* SIGNAL — whether the papers on file are current is the single most
     useful thing a desk can be told about somebody else's customer, and
     a date of expiry is not a way to impersonate anybody. */
  expires_on date,

  /* Which document drives the desk's KYC status. Exactly one per client,
     enforced below — the old shape allowed a "primary" and an array that
     could each claim to be it. */
  is_primary boolean NOT NULL DEFAULT false,

  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS desk_client_documents_client_idx
  ON desk_client_identity_documents (client_id, is_primary DESC, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS desk_client_documents_one_primary
  ON desk_client_identity_documents (client_id)
  WHERE is_primary;

/* ---- the pictures ----------------------------------------------------

   The bytes move to the server, and there are three reasons rather than
   one.

   The blob could not hold them. A phone photograph of a passport is
   three to five megabytes and about a third larger again as base64,
   against a four-megabyte ceiling on the WHOLE desk's saved state.
   `intakeIdImage` (os-src/cdos-base.jsx) already shrinks each one to
   roughly 150 KB, which made the ceiling survivable rather than fixed —
   a busy desk still walks into it, and when it does the desk stops
   saving anything at all.

   A copy in one browser profile is not retention. The desk is obliged to
   produce these for five years. `localStorage` does not survive a
   cleared cache, a new machine, or the second counter needing to see
   what the first one collected.

   And it is what makes the audit real. If the bytes are in the browser,
   "viewing an ID is recorded" is a promise the client-side code makes
   and any reader of the JSON can decline. With the bytes here, the only
   way to see a passport is to ask the server for it, and asking IS the
   audit row. See server/src/clients/records.ts.

   ONE TABLE, TWO PURPOSES, DELIBERATELY DISTINGUISHED. A photograph of
   the client is not another entry in the ID list: different purpose
   (recognising a regular at the counter), different sensitivity, and a
   different retention answer. `purpose` is what keeps them apart — a
   photograph can never be attached to a document, and a document scan
   can never exist without one. */
CREATE TABLE IF NOT EXISTS desk_client_images (
  image_id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES desk_clients(client_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  purpose text NOT NULL
    CHECK (purpose IN ('identity_document','client_photograph')),
  document_id text REFERENCES desk_client_identity_documents(document_id) ON DELETE CASCADE,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  /* So a desk can prove the scan it produces today is the scan it took,
     and so a re-upload of the same picture is recognisable as one. */
  sha256 text NOT NULL,
  bytes bytea NOT NULL,
  label text,
  captured_by text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desk_client_images_purpose_shape CHECK (
    (purpose = 'identity_document' AND document_id IS NOT NULL) OR
    (purpose = 'client_photograph' AND document_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS desk_client_images_client_idx
  ON desk_client_images (client_id, purpose, captured_at DESC);
CREATE INDEX IF NOT EXISTS desk_client_images_document_idx
  ON desk_client_images (document_id)
  WHERE document_id IS NOT NULL;

/* ---- the join to the ledger's own row --------------------------------

   `ledger_customers` is the row the posting path already reads, and it
   stays exactly where it is: workspace-scoped, four columns, untouched
   by this change beyond the column added here. It is the COUNTER RECORD
   — this person, at this till, as the book knows them.

   `client_id` makes it a view of the desk's client rather than a second
   customer concept. One client has as many `ledger_customers` rows as
   the entity has tills; every one of them points at the same person.

   Deliberately nullable and deliberately not a foreign key with a
   cascade: rows predating this migration that cannot be matched to a
   client keep working exactly as they did, and a customer record can
   never be deleted out from under a posted transaction. */
ALTER TABLE ledger_customers ADD COLUMN IF NOT EXISTS client_id text;
CREATE INDEX IF NOT EXISTS ledger_customers_client_idx
  ON ledger_customers (client_id)
  WHERE client_id IS NOT NULL;

/* ============================================================
   CARRYING THE EXISTING DESKS ACROSS

   A desk already trading has its customers in `tenant_state.state ->>
   'cdos_clients_v1'`: a JSON object keyed by name. Every one of them
   arrives here as one client, with the old key kept as an alias.

   Two honest limitations, stated rather than hidden:

     • A tenant with more than one legal entity cannot be attributed —
       the blob never recorded which entity a customer belonged to,
       because the browser had no concept of one. Those tenants take the
       entity created first, which is the desk the blob was written by in
       every case that exists today, and the alternative (skip them)
       would lose customers rather than possibly mis-file them.

     • A blob that is not valid JSON is skipped, not fatal. A migration
       that refuses to run because one desk's browser wrote half a
       document is a migration that blocks every other desk.
   ============================================================ */

/* Postgres has no total cast from text to jsonb, and one desk with a
   truncated document would otherwise abort the whole migration. Dropped
   again at the bottom of this file — it exists for the length of this
   transaction and no longer. */
CREATE OR REPLACE FUNCTION cdos_migration_try_jsonb(input text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$fn$;

/* Empty string means "the desk left the field blank", which is not the
   same as a date and definitely not the same as the epoch. */
CREATE OR REPLACE FUNCTION cdos_migration_date(input text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF input IS NULL OR btrim(input) = '' THEN RETURN NULL; END IF;
  RETURN btrim(input)::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$fn$;

CREATE TEMP TABLE cdos_migration_blob_clients ON COMMIT DROP AS
WITH entity AS (
  SELECT DISTINCT ON (tenant_id) tenant_id, id AS legal_entity_id
    FROM legal_entities
   ORDER BY tenant_id, created_at, id
),
doc AS (
  SELECT s.tenant_id,
         e.legal_entity_id,
         cdos_migration_try_jsonb(s.state->>'cdos_clients_v1') AS clients
    FROM tenant_state s
    JOIN entity e ON e.tenant_id = s.tenant_id
   WHERE s.state ? 'cdos_clients_v1'
)
SELECT d.tenant_id,
       d.legal_entity_id,
       entry.key   AS name_key_raw,
       entry.value AS rec
  FROM doc d
  CROSS JOIN LATERAL jsonb_each(d.clients) AS entry(key, value)
 WHERE d.clients IS NOT NULL
   AND jsonb_typeof(d.clients) = 'object'
   AND jsonb_typeof(entry.value) = 'object'
   AND btrim(entry.key) <> '';

/* One client per name-key. `gen_random_uuid()` rather than anything
   derived from the name — a client id derived from a name is a name key
   wearing a hat. */
INSERT INTO desk_clients (
  client_id, tenant_id, legal_entity_id,
  display_name, date_of_birth, address_line, city, postal_code, email, phone, notes,
  kind, region, country, occupation, risk_rating, verification_status,
  incorporation_date, incorporation_jurisdiction, nature_of_business,
  contact_name, contact_title,
  created_by, updated_by, created_at, updated_at
)
SELECT
  'cli_' || gen_random_uuid(),
  b.tenant_id,
  b.legal_entity_id,
  btrim(b.name_key_raw),
  cdos_migration_date(b.rec->>'dob'),
  nullif(btrim(coalesce(b.rec->>'address','')), ''),
  nullif(btrim(coalesce(b.rec->>'city','')), ''),
  nullif(btrim(coalesce(b.rec->>'postal','')), ''),
  nullif(btrim(coalesce(b.rec->>'email','')), ''),
  nullif(btrim(coalesce(b.rec->>'phone','')), ''),
  nullif(btrim(coalesce(b.rec->>'notes','')), ''),
  CASE WHEN b.rec->>'kind' = 'corporate' THEN 'business' ELSE 'individual' END,
  nullif(btrim(coalesce(b.rec->>'province','')), ''),
  nullif(btrim(coalesce(b.rec->>'country','')), ''),
  nullif(btrim(coalesce(b.rec->>'occupation','')), ''),
  /* The browser's tiers were free text with four spellings of the same
     thing. Anything unrecognised becomes 'normal' rather than being
     dropped or invented upward: a risk rating this migration guessed is
     worse than one the desk is asked to set. */
  CASE lower(btrim(coalesce(b.rec->>'risk','')))
    WHEN 'low' THEN 'low'
    WHEN 'medium' THEN 'medium'
    WHEN 'enhanced' THEN 'medium'
    WHEN 'high' THEN 'high'
    ELSE 'normal'
  END,
  /* Papers on file are 'identified', never 'verified'. Verified means a
     provider authenticated the document, and the blob's presence of an
     ID number is not evidence of that. Claiming it would be this
     migration asserting a KYC outcome nobody paid for. */
  CASE
    WHEN coalesce(btrim(b.rec->>'idType'),'') <> ''
     AND coalesce(btrim(b.rec->>'idNum'),'') <> ''
    THEN CASE
           WHEN cdos_migration_date(b.rec->>'idExpiry') IS NOT NULL
            AND cdos_migration_date(b.rec->>'idExpiry') < current_date
           THEN 'expired'
           ELSE 'identified'
         END
    ELSE 'unverified'
  END,
  cdos_migration_date(b.rec->>'incorpDate'),
  nullif(btrim(coalesce(b.rec->>'jurisdiction','')), ''),
  nullif(btrim(coalesce(b.rec->>'business','')), ''),
  nullif(btrim(coalesce(b.rec->>'contactName','')), ''),
  nullif(btrim(coalesce(b.rec->>'contactTitle','')), ''),
  'migration:019',
  'migration:019',
  coalesce(cdos_migration_date(b.rec->>'createdAt')::timestamptz, now()),
  now()
  FROM cdos_migration_blob_clients b
 WHERE NOT EXISTS (
   SELECT 1 FROM desk_clients existing
    WHERE existing.tenant_id = b.tenant_id
      AND existing.legal_entity_id = b.legal_entity_id
      AND existing.name_key = lower(regexp_replace(btrim(b.name_key_raw), '\s+', ' ', 'g'))
 );

/* The old key, kept. This row is the reason a rename from here on is
   safe: everything that still refers to the customer by the name the
   browser used goes on resolving, forever, through this. */
INSERT INTO desk_client_aliases
  (alias_id, client_id, tenant_id, legal_entity_id, alias, alias_kind, created_by)
SELECT 'als_' || gen_random_uuid(), c.client_id, c.tenant_id, c.legal_entity_id,
       btrim(b.name_key_raw), 'legacy_name_key', 'migration:019'
  FROM cdos_migration_blob_clients b
  JOIN desk_clients c
    ON c.tenant_id = b.tenant_id
   AND c.legal_entity_id = b.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(b.name_key_raw), '\s+', ' ', 'g'))
ON CONFLICT (client_id, alias_key, alias_kind) DO NOTHING;

/* The primary document — the blob's top-level idType / idNum pair. */
INSERT INTO desk_client_identity_documents
  (document_id, client_id, tenant_id, legal_entity_id,
   doc_type, doc_number, issued_on, expires_on, is_primary, created_by, updated_by)
SELECT 'doc_' || gen_random_uuid(), c.client_id, c.tenant_id, c.legal_entity_id,
       btrim(b.rec->>'idType'),
       nullif(btrim(coalesce(b.rec->>'idNum','')), ''),
       cdos_migration_date(b.rec->>'idIssued'),
       cdos_migration_date(b.rec->>'idExpiry'),
       true, 'migration:019', 'migration:019'
  FROM cdos_migration_blob_clients b
  JOIN desk_clients c
    ON c.tenant_id = b.tenant_id
   AND c.legal_entity_id = b.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(b.name_key_raw), '\s+', ' ', 'g'))
 WHERE coalesce(btrim(b.rec->>'idType'),'') <> ''
   AND NOT EXISTS (
     SELECT 1 FROM desk_client_identity_documents d
      WHERE d.client_id = c.client_id AND d.is_primary
   );

/* And every additional document from `ids[]`, each now an equal row
   rather than an entry in an array beside a special one. */
INSERT INTO desk_client_identity_documents
  (document_id, client_id, tenant_id, legal_entity_id,
   doc_type, doc_number, issued_on, expires_on, is_primary, created_by, updated_by)
SELECT 'doc_' || gen_random_uuid(), c.client_id, c.tenant_id, c.legal_entity_id,
       btrim(extra.value->>'type'),
       nullif(btrim(coalesce(extra.value->>'num','')), ''),
       cdos_migration_date(extra.value->>'issued'),
       cdos_migration_date(extra.value->>'expiry'),
       false, 'migration:019', 'migration:019'
  FROM cdos_migration_blob_clients b
  JOIN desk_clients c
    ON c.tenant_id = b.tenant_id
   AND c.legal_entity_id = b.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(b.name_key_raw), '\s+', ' ', 'g'))
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(b.rec->'ids') = 'array' THEN b.rec->'ids' ELSE '[]'::jsonb END
  ) AS extra(value)
 WHERE jsonb_typeof(extra.value) = 'object'
   AND coalesce(btrim(extra.value->>'type'),'') <> '';

/* ---- and the scans themselves, out of the browser ---------------------

   This is the part that actually fixes the saving limit. A desk's
   passport scans are base64 data URLs sitting inside `cdos_clients_v1`,
   which is inside the four-megabyte document that also carries the
   desk's settings and its book — and a desk that goes over that ceiling
   stops saving ANYTHING, silently, until somebody intervenes.

   Moving the bytes here does three things at once: the blob gets small,
   the scan stops living in one browser profile that a cleared cache
   destroys, and — the reason it matters most — the only way to see a
   passport becomes a request to this server, which is what makes "who
   looked at this, and when" a question with an answer.

   A malformed or empty data URL is skipped rather than stored. A row
   that renders as a broken image three years from now, in front of an
   examiner, is worse than an absent one that says so. */
INSERT INTO desk_client_images
  (image_id, client_id, tenant_id, legal_entity_id, purpose, document_id,
   content_type, byte_size, sha256, bytes, label, captured_by)
SELECT 'img_' || gen_random_uuid(), c.client_id, c.tenant_id, c.legal_entity_id,
       'identity_document', d.document_id,
       decoded.mime, octet_length(decoded.raw),
       encode(sha256(decoded.raw), 'hex'), decoded.raw,
       d.doc_type, 'migration:019'
  FROM cdos_migration_blob_clients b
  JOIN desk_clients c
    ON c.tenant_id = b.tenant_id
   AND c.legal_entity_id = b.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(b.name_key_raw), '\s+', ' ', 'g'))
  JOIN desk_client_identity_documents d
    ON d.client_id = c.client_id AND d.is_primary
  CROSS JOIN LATERAL (
    SELECT substring(b.rec->>'photo' from 'data:([a-zA-Z0-9.+/-]+);base64,') AS mime,
           decode(coalesce(substring(b.rec->>'photo' from ';base64,(.*)$'), ''), 'base64') AS raw
  ) AS decoded
 WHERE b.rec->>'photo' LIKE 'data:image/%;base64,%'
   AND decoded.mime IS NOT NULL
   AND octet_length(decoded.raw) > 0
   AND NOT EXISTS (
     SELECT 1 FROM desk_client_images x WHERE x.document_id = d.document_id
   );

/* The same, for every scan attached to an `ids[]` entry. Matched on type
   and number because that pair is what the array row carries; an entry
   with neither is a scan of a document the desk never described, and it
   is left where it is rather than attached to the wrong one. */
INSERT INTO desk_client_images
  (image_id, client_id, tenant_id, legal_entity_id, purpose, document_id,
   content_type, byte_size, sha256, bytes, label, captured_by)
SELECT DISTINCT ON (d.document_id)
       'img_' || gen_random_uuid(), c.client_id, c.tenant_id, c.legal_entity_id,
       'identity_document', d.document_id,
       decoded.mime, octet_length(decoded.raw),
       encode(sha256(decoded.raw), 'hex'), decoded.raw,
       d.doc_type, 'migration:019'
  FROM cdos_migration_blob_clients b
  JOIN desk_clients c
    ON c.tenant_id = b.tenant_id
   AND c.legal_entity_id = b.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(b.name_key_raw), '\s+', ' ', 'g'))
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(b.rec->'ids') = 'array' THEN b.rec->'ids' ELSE '[]'::jsonb END
  ) AS extra(value)
  JOIN desk_client_identity_documents d
    ON d.client_id = c.client_id
   AND NOT d.is_primary
   AND lower(btrim(d.doc_type)) = lower(btrim(extra.value->>'type'))
   AND coalesce(lower(btrim(d.doc_number)),'') = coalesce(lower(btrim(extra.value->>'num')),'')
  CROSS JOIN LATERAL (
    SELECT substring(extra.value->>'photo' from 'data:([a-zA-Z0-9.+/-]+);base64,') AS mime,
           decode(coalesce(substring(extra.value->>'photo' from ';base64,(.*)$'), ''), 'base64') AS raw
  ) AS decoded
 WHERE extra.value->>'photo' LIKE 'data:image/%;base64,%'
   AND decoded.mime IS NOT NULL
   AND octet_length(decoded.raw) > 0
   AND NOT EXISTS (
     SELECT 1 FROM desk_client_images x WHERE x.document_id = d.document_id
   );

/* The contact photograph — `avatar` in the blob — which is a different
   thing from an ID scan and is kept as one: different purpose, different
   sensitivity, different answer to "how long must this be kept". */
INSERT INTO desk_client_images
  (image_id, client_id, tenant_id, legal_entity_id, purpose, document_id,
   content_type, byte_size, sha256, bytes, label, captured_by)
SELECT 'img_' || gen_random_uuid(), c.client_id, c.tenant_id, c.legal_entity_id,
       'client_photograph', NULL,
       decoded.mime, octet_length(decoded.raw),
       encode(sha256(decoded.raw), 'hex'), decoded.raw,
       'contact photograph', 'migration:019'
  FROM cdos_migration_blob_clients b
  JOIN desk_clients c
    ON c.tenant_id = b.tenant_id
   AND c.legal_entity_id = b.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(b.name_key_raw), '\s+', ' ', 'g'))
  CROSS JOIN LATERAL (
    SELECT substring(b.rec->>'avatar' from 'data:([a-zA-Z0-9.+/-]+);base64,') AS mime,
           decode(coalesce(substring(b.rec->>'avatar' from ';base64,(.*)$'), ''), 'base64') AS raw
  ) AS decoded
 WHERE b.rec->>'avatar' LIKE 'data:image/%;base64,%'
   AND decoded.mime IS NOT NULL
   AND octet_length(decoded.raw) > 0
   AND NOT EXISTS (
     SELECT 1 FROM desk_client_images x
      WHERE x.client_id = c.client_id AND x.purpose = 'client_photograph'
   );

/* ---- the ledger's rows, joined to the person --------------------------

   Every `ledger_customers` row now points at a client. Where the desk's
   blob already produced one with the same name in the same entity, it
   attaches to that; where it did not — a customer created straight at
   the till, which the ledger has always allowed — a client is minted
   from what the ledger row knows.

   Matching on the normalised NAME is not a principle, it is the only
   correspondence that exists between the two stores today. It is exactly
   the matching this whole change exists to stop doing, and it is being
   done once, here, on data that was already merged by name and cannot be
   un-merged. Every record written from now on carries an id. */
UPDATE ledger_customers lc
   SET client_id = c.client_id
  FROM desk_clients c
 WHERE lc.client_id IS NULL
   AND c.tenant_id = lc.tenant_id
   AND c.legal_entity_id = lc.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(lc.name), '\s+', ' ', 'g'));

INSERT INTO desk_clients (
  client_id, tenant_id, legal_entity_id, display_name,
  risk_rating, verification_status, created_by, updated_by, created_at, updated_at
)
SELECT DISTINCT ON (lc.tenant_id, lc.legal_entity_id,
                    lower(regexp_replace(btrim(lc.name), '\s+', ' ', 'g')))
       'cli_' || gen_random_uuid(),
       lc.tenant_id, lc.legal_entity_id, btrim(lc.name),
       CASE lower(coalesce(lc.risk,''))
         WHEN 'high' THEN 'high'
         WHEN 'enhanced' THEN 'medium'
         WHEN 'medium' THEN 'medium'
         WHEN 'low' THEN 'low'
         ELSE 'normal'
       END,
       CASE lower(coalesce(lc.id_status,''))
         WHEN 'verified' THEN 'verified'
         WHEN 'expired' THEN 'expired'
         WHEN 'pending' THEN 'identified'
         ELSE 'unverified'
       END,
       'migration:019', 'migration:019',
       coalesce(lc.created_at, now()), now()
  FROM ledger_customers lc
 WHERE lc.client_id IS NULL
   AND btrim(coalesce(lc.name,'')) <> ''
 ORDER BY lc.tenant_id, lc.legal_entity_id,
          lower(regexp_replace(btrim(lc.name), '\s+', ' ', 'g')),
          lc.created_at, lc.customer_id;

UPDATE ledger_customers lc
   SET client_id = c.client_id
  FROM desk_clients c
 WHERE lc.client_id IS NULL
   AND c.tenant_id = lc.tenant_id
   AND c.legal_entity_id = lc.legal_entity_id
   AND c.name_key = lower(regexp_replace(btrim(lc.name), '\s+', ' ', 'g'));

/* ---- and now say, out loud, where a file may be two people -----------

   Neither of these splits anything. Both put a flag and a sentence on a
   record so that somebody who knows the customers can look. */

/* Two documents of the same TYPE carrying different numbers. One person
   has one passport. Two passports on one file is either a renewal
   somebody recorded twice — harmless, and worth a glance — or it is two
   people who share a name and were merged by the old store, which is the
   defect this whole change exists to end. */
UPDATE desk_clients c
   SET possible_duplicate = true,
       duplicate_reason =
         'This file holds more than one document of the same type with different numbers. '
         || 'That is either a renewal recorded twice or two people merged under one name by the old, name-keyed store. '
         || 'Nothing has been split — check the file and separate it if it is two customers.'
 WHERE EXISTS (
   SELECT 1
     FROM desk_client_identity_documents a
     JOIN desk_client_identity_documents b
       ON b.client_id = a.client_id
      AND b.document_id <> a.document_id
      AND lower(btrim(b.doc_type)) = lower(btrim(a.doc_type))
      AND nullif(btrim(a.doc_number),'') IS NOT NULL
      AND nullif(btrim(b.doc_number),'') IS NOT NULL
      AND lower(btrim(a.doc_number)) <> lower(btrim(b.doc_number))
    WHERE a.client_id = c.client_id
 );

/* Two records in one entity that normalise to the same name. Not a fault
   — it is the correct outcome, two people who share a name are two
   records — but it is precisely the pair the old store would have
   collapsed, so the desk is told they exist rather than left to find out
   at the counter. */
UPDATE desk_clients c
   SET possible_duplicate = true,
       duplicate_reason = coalesce(c.duplicate_reason || ' ', '')
         || 'Another customer of this desk has the same name. They are kept as separate records, which is correct — '
         || 'check that transactions and documents are on the right one.'
 WHERE EXISTS (
   SELECT 1 FROM desk_clients other
    WHERE other.tenant_id = c.tenant_id
      AND other.legal_entity_id = c.legal_entity_id
      AND other.name_key = c.name_key
      AND other.client_id <> c.client_id
 );

DROP FUNCTION IF EXISTS cdos_migration_try_jsonb(text);
DROP FUNCTION IF EXISTS cdos_migration_date(text);

/* ---- what is NOT done here -------------------------------------------

   The blob key is left exactly where it is. A browser that has not
   reloaded still holds `cdos_clients_v1` and still replicates it, and
   the persistence bridge merges per key against a baseline — deleting
   the key here would be seen by that browser as "they deleted it, I did
   not touch it", the deletion would win, and then the NEXT save from an
   older tab would put a stale copy back. See the merge rules at the top
   of os-src/cdos-persist.js.

   So the server becomes the record and the blob becomes a cache of it:
   the Clients screen reads and writes the routes in
   server/src/clients/routes.ts and projects what it gets back into the
   old shape for the screens that have not moved yet (the ledger, the
   transaction modal, compliance, reports). Scans are the exception and
   are dropped from the projection deliberately — they are the largest
   contributor to the four-megabyte ceiling and they now live in
   `desk_client_images`, where a passport is fetched only by a request
   that records who asked. */
