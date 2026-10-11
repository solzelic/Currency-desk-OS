# Client Records

The rule this document exists to state: **a customer is a person, and a
person is not the spelling of their name.** A client record has an
identity that never changes; the name is an attribute of it, like the
phone number.

This was not true for most of this project's life, and the cost is worth
recording, because it is the reason the product could not be given to a
real shop.

Every customer file lived in a browser, in `localStorage` under
`cdos_clients_v1`, as one object **keyed by the customer's name**. Four
things followed from that single decision:

- **Two people called David Chen were one file.** The second one to walk
  in inherited the first one's date of birth, the first one's passport
  number, the first one's risk rating and the first one's transaction
  history — and the desk, looking at a screen that said "David Chen ·
  Verified", had no way to see it had happened. The reverse was as bad:
  correcting "Jonh" to "John" *moved the key*, and everything already
  filed under the old spelling stopped resolving.
- **Nothing about a customer was queryable or provable.**
  `ledger_customers` carried four columns — an external reference, a
  name, a risk word, an ID status word. Date of birth, address, ID
  number, ID expiry, screening outcome, the scans: all of it existed only
  in one browser profile on one counter machine. A desk is required to
  retain these and produce them on demand for five years, and it could
  not produce them at all.
- **Two counters were two shops.** Each browser held its own copy, so the
  customer identified at till 1 was a stranger at till 2.
- **It was the biggest thing in a bounded store.** Passport scans, as
  base64 data URLs, inside the same four-megabyte document that carries
  the desk's settings and its book. A desk that hit that ceiling stopped
  saving *anything* — see `os-src/cdos-persist.js`.

## The model

```
desk_clients                     the person.       (tenant, legal entity)
  desk_client_aliases            every name they have been known by
  desk_client_identity_documents what identifies them, one row per document
  desk_client_images             the pictures — scans, and the photograph
ledger_customers.client_id       the ledger's counter record, joined
```

**Scope is the legal entity, not the branch.** One shop's customer is
that shop's customer at every counter it has and at every location it
ever opens. Multi-branch is not today's priority, but this is the one
decision that decides whether the second location costs an afternoon or a
rewrite, and it is made here.

**`client_id` is never a name and is never derived from one.** A rename
is an `UPDATE` to one column. Nothing moves, nothing is orphaned, nothing
collides. That sentence is the entire point of the table.

**`name_key` is not unique and must never become unique.** It exists so a
collision can be made *visible*. Two customers legitimately share a name;
creating the second is allowed and the desk is told, on screen, every
time it opens either of them. A product that refuses the second David
Chen is the same defect as one that merges them, wearing a warning label.

**`ledger_customers` stays where it is.** It is the *counter record* —
this person, at this till, as the posting path knows them — and it is
workspace-scoped because the posting path is. It gained one column,
`client_id`, which makes it a view of the desk's client rather than a
second customer concept. One client has as many counter records as the
entity has tills; every one of them points at the same person.

The posting gate does not read `ledger_customers.id_status`. ID on file
is a typed row in `desk_client_identity_documents` (or an approved
document in that table). `POST` and `PUT /api/ledger/customers` refuse
a standing sent on the body. See `docs/LEDGER_POSTING_API.md`.

## Identifying and signal

Every field is on one of two sides of a line, and the split is
structural: separate tables, and an executable classification in
`server/src/clients/classification.ts` that a test holds to.

**Identifying** — enough, alone or together, to *be* this person. It
belongs to the desk that collected it, under the consent that desk
obtained, and it never leaves.

| field | where |
|---|---|
| legal name | `desk_clients.display_name` |
| aliases and former names | `desk_client_aliases.alias` |
| date of birth | `desk_clients.date_of_birth` |
| street address | `desk_clients.address_line` |
| city | `desk_clients.city` |
| postal code | `desk_clients.postal_code` |
| email | `desk_clients.email` |
| phone | `desk_clients.phone` |
| free-text notes | `desk_clients.notes` |
| a business's named contact and their title | `desk_clients.contact_name`, `contact_title` |
| document number | `desk_client_identity_documents.doc_number` |
| issuing jurisdiction | `desk_client_identity_documents.issuing_jurisdiction` |
| date of issue | `desk_client_identity_documents.issued_on` |
| every scan and the client photograph | `desk_client_images.bytes` |

**Signal** — describes the person without being enough to be them.

| field | where |
|---|---|
| individual or business | `desk_clients.kind` |
| region / province | `desk_clients.region` |
| country | `desk_clients.country` |
| occupation | `desk_clients.occupation` |
| risk rating | `desk_clients.risk_rating` |
| verification status | `desk_clients.verification_status` |
| when verified | `desk_clients.verified_at` |
| screening outcome, and what it matched | `desk_clients.screening_outcome`, `screening_matched` |
| when screened | `desk_clients.screened_at` |
| what KIND of document identified them | `desk_client_identity_documents.doc_type` |
| when the documents expire | `desk_client_identity_documents.expires_on` |
| incorporation date, jurisdiction, nature of business | `desk_clients.incorporation_*`, `nature_of_business` |
| possible-duplicate flag | `desk_clients.possible_duplicate` |
| created / updated timestamps | `desk_clients.created_at`, `updated_at` |

Three of these placements are worth the sentence they cost.

*Notes are identifying* because they cannot be classified at all. "Sister
of the woman at 14 Elm who came in Tuesday" identifies two people, and
there is no way to know in advance that somebody wrote it.

*Region but not street.* A province is a jurisdiction, which is what a
risk judgement is actually made against. A house number is a doorstep
somebody can be found at.

*Incorporation details are signal, a date of birth is not.* A company's
registration is a public register entry in every jurisdiction shipped
here. A person's date of birth is half of most identity checks.

### What this is for, and what is deliberately not built

The owner intends, later and deliberately, to let one desk learn that a
person is **known to the network** — screened, a hit, high risk — without
ID numbers or scans ever leaving the desk that holds them.

**That is not built here and must not be.** It needs a legal basis:
consent captured at onboarding, purpose limitation, data minimisation.
Those are the owner's decisions, not this change's, and a product that
started sharing on the strength of an engineer's judgement would be worse
than one that never shared at all.

What this change owes that decision is that it stays *possible*. The
migration that untangles personal data from signal after the fact, across
every desk's live customers, is the one nobody ever gets to do — it needs
a lawyer, a downtime window and a per-field judgement call on data
somebody is already trading against. So:

- The split is a **table boundary**, not a convention. A description of a
  customer that carries no identifying data joins nothing in
  `desk_client_identity_documents` and nothing in `desk_client_images`.
- `signalView()` in `server/src/clients/classification.ts` is built by
  **allow-list**. A column nobody has classified is invisible to it,
  which is the correct default: a field nobody has thought about is a
  field nobody may share. A test asserts that no identifying key can
  appear in what it returns.
- Nothing calls it. There is no route that returns a signal view and no
  caller that builds one. The shape exists, is proven, and is wired to
  nothing.

**The matching column.** `desk_clients.network_match_hash` and
`network_match_hash_version` exist and are written by nothing. Adding a
nullable column now costs nothing; adding it later costs a migration over
live personal data. What the hash *should* be over, when somebody builds
matching: a salted one-way digest of (date of birth, normalised legal
name) for an individual, or (incorporation jurisdiction, registration
number) for a business. **Never an ID number** — a digest of an ID number
is a lookup table anybody can build. The salt has to be shared across
desks for two desks to agree, and shared salt is exactly the design
question that needs the legal basis above. The `_version` column is what
stops the column committing to anything: the input definition may change
completely, and rows written under an old one stay identifiable rather
than silently comparing false.

**No consent column is added.** Capturing a boolean with no consent text,
no version of that text, and no screen on which consent is actually
obtained would be worse than nothing — a field that *claims* a legal
basis nobody established. When the owner decides what is being consented
to, that is the change that adds it.

## Identity documents

Their own table, one row per document, and this is not tidiness.

A person legitimately holds several — a passport, a driving licence, a
permanent-resident card — issued by different governments and expiring on
different days. The old shape had a "primary" ID as loose fields
(`idType`, `idNum`, `idIssued`, `idExpiry`) beside an `ids[]` array, so
the first document was structurally different from every other one and
every screen had to special-case it. Now exactly one row per client
carries `is_primary`, enforced by a partial unique index, and it is the
one that drives the desk's KYC standing.

`verification_status` is derived from the documents, not typed:

- no document with a number, leaving out health cards → `unverified`
- the primary document, when it is not a health card, is past its
  expiry → `expired`
- otherwise → `identified`

`verified` is never set or cleared by that derivation. It means a
provider authenticated the document and was paid to do it. No amount of
adding or removing rows in this table can grant that, and nothing here
may quietly take it away.

The till's counter record (`ledger_customers.id_status`) leaves health
cards out the same way: a file whose only numbered document is a health
card is `missing`. A file stored as `identified` before this rule reads
as `unverified` until its next document write stores that. The posting
gate itself is unchanged; PR #108 owns it.

## ID-document types

One catalogue, `shared/id-document-types.js`. The server requires it
(`server/src/clients/id-document-types.ts` only adds types) and the desk
shell loads the same file as a script before `cdos-backend.js`;
`scripts/build-os.mjs` puts it in `web/app/os.js`. The uncompiled shell
fetches `/shared/id-document-types.js`, which is on the static
allow-list only while `web/app/index.html` is absent, like `os-src/`.

Each type has a `code`, the `label` the desk shows and the server
stores, a `kind` (`person` or `business`), `photo`, `mayLackExpiry`,
`acceptedAsId`, and `aliases`. A name matches a whole type after one
fold, the same in JavaScript and in Postgres: lower case, apostrophes
dropped, every other run of characters outside a–z and 0–9 turned into
one space.

| label | kind | photo | may lack expiry | aliases (some) |
|---|---|---|---|---|
| Driver's Licence | person | yes | no | Driver's License, Drivers Licence |
| Passport | person | yes | no | |
| Provincial/Territorial Photo ID | person | yes | no | Provincial ID, Territorial ID, Ontario Photo Card |
| Permanent Resident Card | person | yes | no | PR Card |
| Citizenship Card | person | yes | yes | Canadian Citizenship Card |
| BC Services Card | person | yes | no | BC Services Card with photo |
| National Identity Card | person | yes | no | National ID, Identity Card, Emirates ID |
| Health Card | person | no | no | about forty provincial names; **not accepted as ID** |
| Business Number | business | no | yes | BN |
| Incorporation Certificate | business | no | yes | Certificate of Incorporation |
| Master Business Licence | business | no | yes | Master Business License |
| Articles of Incorporation | business | no | yes | |

The **BC Services Card** is a government photo ID and FINTRAC accepts
it. It is not on the health-card list. Neither is a bare "Medicare" or
"Medicare card", because that is also the name of Australia's card.

A document add or a type change (`POST|PATCH
/api/clients/:clientId/documents`) stores the catalogue label, so
"PR Card" is stored as "Permanent Resident Card". A type the catalogue
does not list is **422** `{ error: "ID_TYPE_NOT_IN_CATALOGUE", detail }`,
and the detail names the types this shop accepts. "Not stated" is not a
type: it is the placeholder the desk writes when Add ID opens a row
before a type is picked, and it is still accepted. The response also
carries `code` and `message`, the shape every other refusal on these
routes has.

A row already stored under any other name reads as it was stored. No
stored row is rewritten.

## Accepted IDs, per shop

The owner chooses which catalogue types their shop accepts in
**Settings → Accepted IDs**, one switch per type, in Person and
Business groups. The owner asked for "accepted IDs, not accepted IDs,
within reason"; the reason is the jurisdiction pack.

- **Stored** on `legal_entities.accepted_id_types` (migration 047), as
  catalogue codes. **NULL follows the pack**, and every desk starts
  there. A save that lands on the pack's own list stores NULL again, so
  the shop keeps following the pack.
- **Pack defaults and locks are code**, in
  `server/src/ledger/id-type-rules.ts`, keyed by the pack's
  jurisdiction. Every type the catalogue accepts is on by default in
  every pack. A pack can **lock** a type off with a short legal note; a
  locked type is off whatever the shop stored, shows a padlock and the
  note, and cannot be switched on. The health card is locked in every
  pack. Canada's note: FINTRAC says not to use a health card where
  provincial law forbids it, and Ontario's Health Cards and Numbers
  Control Act bars it.
- **The route.** `GET /api/clients/accepted-id-types` is every role's,
  because every ID picker reads it; it returns each type with `on`,
  `packDefault`, `locked`, `note`, plus `accepted`, `followsPack`, and
  `canChange`. `PUT` with `{ accepted: [codes] | null }` is the
  owner's (`compliance:thresholds`). A manager or a teller gets **403**,
  "Only the owner can change which IDs this shop accepts." Switching on
  a locked type is **422** `ID_TYPE_LOCKED`, naming the note. A list
  with no person photo ID is **422** `PHOTO_ID_REQUIRED`, "Keep at least
  one photo ID switched on." Business types may all be off. Nothing is
  written on a refusal.
- **Audited.** A change writes `desk.id_types.change` to
  `ledger_audit_events`: what was switched on and off, whether the shop
  now follows the pack, and how many IDs on file are a type just
  switched off. Never a document number.
- **New documents.** Adding a document of a type the shop has switched
  off, or changing a document to one, is **422**
  `{ error: "ID_TYPE_NOT_ACCEPTED_HERE", detail: "This shop doesn't
  accept {label}. The owner can change this in Settings → Accepted
  IDs." }`. Sending a document's own type back unchanged, and
  correcting its number or dates, still works.
- **Customers already on file are never deleted or rewritten.** A
  document whose type the shop has since switched off reads in full,
  keeps its verification status and the till's counter record, and
  carries `notice: "This shop no longer accepts {label}. Record another
  ID at the next visit."`. The client file and the editors show that
  line quietly. It is computed on the read; there is no data migration.
- **The desk.** Every ID picker (the client file, the quick card,
  Record the ID, the ledger's quick add) offers the catalogue's types
  less what this shop switched off. A switched-off type on file stays
  visible as the current value and cannot be chosen again. A manager
  sees the Settings list read-only. A refused save shows the server's
  sentence and does not say Saved.

## Health card numbers

A health card is not ID, and its number is not kept, shown, searched,
or sent. In Ontario, the Health Cards and Numbers Control Act, 1991
bars a business outside health care from collecting or using a health
number. FINTRAC says not to use a health card where provincial law
prohibits it. The desk refuses them everywhere, in every province and
every country. That is stricter than the law, which is allowed.

- **A new one is refused.** Adding a document whose type is a health
  card, or changing a type to one, is **422** `{ error:
  "HEALTH_CARD_NOT_ID", detail: "Health cards can't be used as ID.
  Record a current photo ID." }`. Nothing is written.
- **A stored one cannot be edited.** A new number would be a health
  number newly stored, and a new type would put the stored number under
  another document's name. It can be removed, and a new primary document
  can be added beside it; the health card is then an additional row.
- **No read returns the number.** The `docNumber` key is absent, not
  null and not masked, on one client, the list, and name lookup. The
  type, issuing jurisdiction, dates, and scan flag stay.
- **The saved desk does not carry one.** `/api/tenant/state` removes a
  health number from the document on save, on read, and from a conflict
  body. The desk removes one from every `localStorage` value when it
  loads, before a save is built, and after the server's copy is written
  in. Unchanged values are kept byte for byte. The desk stores nothing in
  IndexedDB, so there is nothing there to clean.
- **The desk never shows or copies one.** A health card on the client
  file reads "Health card — not accepted as ID", with no Number row, on
  the file, the quick card, the editors, and the printable report. The
  Client & KYC Register sheet and its CSV leave the number cell empty.
  Client search does not match it. LCTR and STR identifier fields are
  filled only from a type the catalogue accepts; otherwise they are
  empty for the filer to type from the document.

**The stored number is not blanked here.** It stays in
`desk_client_identity_documents.doc_number`, and in any backup, until
the owner runs the redaction tool in PR #134, which is a separate
change. Scans are unchanged: a health-card scan, if one was taken, is
still opened only through the audited reveal.

## Scans, and the photograph

**The bytes moved to the server**, into `desk_client_images`. Three
reasons, and the third is the one that matters most.

The blob could not hold them. A phone photograph of a passport is three
to five megabytes and about a third larger again as base64, against a
four-megabyte ceiling on the *whole* desk's saved state. `intakeIdImage`
(`os-src/cdos-base.jsx`) already shrinks every intake to roughly 150 KB,
which made the ceiling survivable rather than fixed — a busy desk still
walks into it, and when it does the desk stops saving anything at all.

A copy in one browser profile is not retention. The desk must produce
these for five years. `localStorage` does not survive a cleared cache, a
new machine, or the second counter needing to see what the first one
collected.

And it is what makes the audit real. If the bytes are in the browser,
"viewing an ID is recorded" is a promise the client-side code makes and
any reader of the JSON can decline. With the bytes on the server, the
only way to see a passport is to ask for it, and asking *is* the record.

**A photograph of the client is not another entry in the ID list.** Same
table, different `purpose`, and a check constraint keeps them apart: a
photograph can never be attached to a document, and a document scan can
never exist without one. They differ in every way that matters — an
identity document is evidence the desk is *obliged* to keep, a
photograph the desk took is a convenience it *chose* — and storing them
as one thing would make them inseparable at exactly the moment somebody
has to decide what to delete.

## What viewing an identity document records

`POST /api/clients/:clientId/documents/:documentId/reveal` writes a
`ledger_audit_events` row with action `client.document.view` **in the
same transaction that returns the bytes.** Not afterwards, not
best-effort: the read and the record of the read either both happen or
neither does. And there is no other path to the bytes — they are not in
the desk's saved state, not in the list response, and not in the record
response, which carry `hasScan` and nothing more.

The row says **who looked, at which customer's document of which type, at
which till, and when.** It does not say the document's number. An audit
trail that quotes passport numbers is a second copy of the thing being
protected, in a table designed to be read widely and kept for years.

**This is not a permission.** Anybody who can open a client file can
already see the document if they want it, and gating it would be theatre.
What changes is that looking is deliberate and leaves a trace — "who
looked at this customer's passport, and when" is a question a regulator
asks, and the answer used to be that nobody could say.

Every opening is its own row. "Somebody looked once, months ago" and
"three people looked this morning" are different facts and the second is
the one that gets asked about. `GET /api/clients/:clientId/disclosures`
is the answer.

A **POST**, not a GET, and not for REST tidiness: a GET is what a browser
prefetches, a proxy caches and a crawler follows, and "who looked at this
passport" must not have the answer "the cache did, forty times".

Removing a scan is audited too (`client.document.scan.remove`). A scan
that quietly stopped existing is a record-keeping failure somebody has to
be able to date.

The **client photograph is not audited this way**. Treating a face the
desk photographed itself as equivalent to a government document would
fill the trail with noise and make the rows that matter harder to find.

## What retention obliges

The desk's retention period is its jurisdiction pack's, tightened by the
desk if it chooses — `legal_entities.retention_years`, see
`docs/DESK_THRESHOLDS.md`. Five years in every pack shipped except
Australia's seven.

What that means for these tables, stated so the deletion job somebody
writes later has something to be right about:

- **Identity documents and their scans** are the evidence behind an
  identification. They are retained for the desk's retention period,
  measured from the desk's last transaction with that customer — not from
  when the document was captured.
- **The client photograph** is not that evidence. It is a convenience,
  and it is the first thing that should go. It is a separate `purpose` on
  a separate row precisely so that it *can* go without touching anything
  the regulator asked for.
- **The disclosure trail** is the record of who saw what. It lives in
  `ledger_audit_events`, which is append-only by trigger, and it outlives
  the document it describes: "we deleted that scan in 2029" is only
  answerable if the rows about it survive the scan.
- **Aliases are never deleted while the client exists.** They are what
  makes historic filings resolve. An alias row removed is a transaction
  from three years ago that no longer points at anybody.
- **A client record is never deleted while a transaction references its
  counter record.** `ledger_customers.client_id` is deliberately not a
  cascading foreign key for exactly that reason.

None of that deletion is implemented. It is written down because the
schema was shaped to make it possible, and a retention policy that only
exists in somebody's head is the one that gets discovered during an
audit.

## Migrating a desk that is already trading

`019_client_records.sql` carries the blob across. Per name-key: one
client, the old key kept as a `legacy_name_key` alias, the primary ID and
every `ids[]` entry as equal document rows, and every scan and the
contact photograph decoded out of the data URLs into `desk_client_images`.

**What it cannot fix.** The merge has already happened. Where a desk's
blob has one "David Chen" holding two people's papers, nothing can
separate them — splitting on a guess would invent a customer who never
existed and hand half a transaction history to each. So the migration
does not try. It sets `possible_duplicate` with a `duplicate_reason`
somebody can act on, in two cases:

- the file holds **more than one document of the same type with different
  numbers** — one person has one passport;
- **another customer of the same legal entity has the same name** — which
  is the correct outcome, and is precisely the pair the old store would
  have collapsed.

Neither splits anything and neither merges anything further. Both ask for
a human.

Two limitations stated rather than hidden. A tenant with more than one
legal entity cannot be attributed — the blob never recorded which entity
a customer belonged to, because the browser had no concept of one — so
those take the entity created first, which is the desk the blob was
written by in every case that exists today. And a blob that is not valid
JSON is skipped, not fatal: a migration that refuses to run because one
desk's browser wrote half a document is a migration that blocks every
other desk.

**The blob key is left in place.** The browser replicates `cdos_*` keys
to the server as one document and merges on conflict *per key*, against a
baseline (see the header of `os-src/cdos-persist.js`). Deleting the key
server-side would look to a browser that has not reloaded like "they
deleted it, I did not touch it" — the deletion wins, and then the next
save from an older tab puts a stale copy back.

So the server becomes the record and the blob becomes a **cache** of it.
The Clients screen reads and writes `/api/clients/*` and projects what it
gets back into the old name-keyed shape for the screens that have not
moved yet — the Ledger, the transaction modal, compliance, reports, the
dashboard. That projection obeys two rules:

- it never **deletes** anything it did not put there, so a record the
  server has never heard of stays exactly where it is;
- it drops a **scan** only where the server holds that scan. That is the
  byte weight that was breaking saving, and it is the one thing the
  projection is allowed to take away.
- it drops a **supporting file** the same way, once the server holds that
  label and file name. A copy the migration could not read stays in the
  browser and the folder says so.

## What is still in the browser

Named plainly, because "the customer record is on the server" should not
be read as more than it is:

- **The extra photo gallery** (`gallery[]`). Still in `cdos_clients_v1`.
  A gallery picture is not a paper filed for the customer. Supporting
  files — proof of address, source of funds, corporate filings — moved
  to `desk_client_images` with purpose `supporting_file`. They are not
  identity documents: saving one does not change `verification_status`.
- **Beneficiaries** (`cdos_beneficiaries_v1`) — who a client sends money
  to. The other half of a remittance record, and browser-only.
- **KYC provider checks** (`cdos_kyc_v1`) — the evidence behind
  `verification_status`. The status is on the server; the inquiry that
  produced it is not.
- A desk with **no ledger database** keeps the browser-only store
  entirely. The client routes register only where the ledger's do,
  because they join `ledger_customers`, which the embedded database has
  never had.

## Where the answers come from

| question | route |
|---|---|
| who are this shop's customers | `GET /api/clients` |
| who is this, given a name (aliases included) | `GET /api/clients/lookup?name=` |
| everything about one customer | `GET /api/clients/:clientId` |
| open a file / change one | `POST /api/clients`, `PATCH /api/clients/:clientId` |
| what identifies them | `POST|PATCH|DELETE /api/clients/:clientId/documents[/:documentId]` |
| show me the passport (audited) | `POST /api/clients/:clientId/documents/:documentId/reveal` |
| who has looked at this customer's documents | `GET /api/clients/:clientId/disclosures` |
| the photograph | `PUT|GET /api/clients/:clientId/photograph` |
| papers filed for them (label only) | `POST|PATCH|DELETE /api/clients/:clientId/files[/:fileId]` |
| open one of those papers (audited) | `POST /api/clients/:clientId/files/:fileId/reveal` |
| this person, as the till's counter record | `POST /api/clients/:clientId/counter-record` |

## Testing

Per `docs/CASH_OWNERSHIP_INVARIANTS.md`, "testing standard": both sides,
every time.

- `server/tests/client-records.postgres.test.ts` — identity across a
  rename, two same-name customers as two records, visibility from a
  second till and a second branch and *not* from another tenant,
  documents as separate rows, the audit row a reveal writes, the
  identifying/signal boundary, and migration 019 run over a real blob.
- `server/tests/id-document-types.test.ts` — the catalogue: every type
  and its fields, aliases, the BC Services Card accepted, the health
  names refused and the near-misses not matched, the scrub, and the
  shell and bundle loading the one file.
- `server/tests/id-catalogue.postgres.test.ts` — the two 422s over
  HTTP with their exact bodies, business types and the placeholder
  accepted, legacy health and unknown-type rows read without rewriting,
  no health number in any read or lookup, a stored health card not
  editable, the counter record `missing` for a health card only, the
  Postgres fold equal to the JavaScript fold, and the tenant-state
  scrub on save, read, conflict, and a teller's read.
- `server/tests/accepted-id-rules.test.ts` — pack defaults (every
  accepted type on, in every pack), the health card locked everywhere
  with Canada's note, a later pack locking another type, and the
  sentences.
- `server/tests/accepted-id-types.postgres.test.ts` — the route: every
  role reads, the owner changes, a manager and a teller get 403 with
  nothing changed, the audit row, a locked type and a list with no
  photo ID refused; the switched-off refusal on add and on update; a
  switched-off ID on file read with its status and notice; NULL
  following the pack; the column constraint.
- `tests/e2e/accepted-ids-seam.spec.ts` — the owner's switch reaching
  the server, a refused save showing the server's sentence and not
  Saved, a manager's read-only list, and the client file's notice and
  picker following the list.
- `tests/e2e/health-card-seam.spec.ts` — a health card already in the
  database and in this browser's saved copy: after the desk loads the
  number is not in `localStorage`, search does not find it, the file
  says "Health card — not accepted as ID" with no number, the pickers
  offer the BC Services Card and never a health card, and an LCTR
  identifier is empty for a health card and filled for a passport.
- `tests/e2e/client-records-seam.spec.ts` — a client created through the
  desk's own screen and then found on the server; a rename after a posted
  deal, with the deal still resolving and the old name still finding
  them; two same-name contacts and the warning the screen shows; an ID
  opened by clicking the covered placeholder, and the server audit row
  that appears because it was.
