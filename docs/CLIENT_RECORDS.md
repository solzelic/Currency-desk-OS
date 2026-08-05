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

- no document with a number → `unverified`
- the primary document is past its expiry → `expired`
- otherwise → `identified`

`verified` is never set or cleared by that derivation. It means a
provider authenticated the document and was paid to do it. No amount of
adding or removing rows in this table can grant that, and nothing here
may quietly take it away.

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

## What is still in the browser

Named plainly, because "the customer record is on the server" should not
be read as more than it is:

- **Supporting documents** (`docs[]` — proof of address, source of funds,
  corporate filings) and the **extra photo gallery** (`gallery[]`). They
  are still in `cdos_clients_v1`, still counting against the saving
  ceiling. They are the obvious next thing to move and they need nothing
  new to do it — `desk_client_images` already has room for a third
  `purpose`.
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
| this person, as the till's counter record | `POST /api/clients/:clientId/counter-record` |

## Testing

Per `docs/CASH_OWNERSHIP_INVARIANTS.md`, "testing standard": both sides,
every time.

- `server/tests/client-records.postgres.test.ts` — identity across a
  rename, two same-name customers as two records, visibility from a
  second till and a second branch and *not* from another tenant,
  documents as separate rows, the audit row a reveal writes, the
  identifying/signal boundary, and migration 019 run over a real blob.
- `tests/e2e/client-records-seam.spec.ts` — a client created through the
  desk's own screen and then found on the server; a rename after a posted
  deal, with the deal still resolving and the old name still finding
  them; two same-name contacts and the warning the screen shows; an ID
  opened by clicking the covered placeholder, and the server audit row
  that appears because it was.
