# How CurrencyDesk is built

This is the governing document. When the code disagrees with it, one of the
two is wrong and that needs saying out loud rather than working around.

Written for whoever is holding this next — a new engineer, an auditor, a
model with a large context window, or the same person in eighteen months
having forgotten why any of it is like this.

> **This replaces the previous ARCHITECTURE.md**, which described a Vite +
> TypeScript app under `src/` as the production migration path and the
> buildless OS as a "preserved prototype" not to be refactored. That app was
> deleted (its CI was green while the shipped code went unwatched, which is
> how a dead Settings screen survived for days). The inversion is total: the
> buildless OS *is* the product. `docs/THREAT_MODEL.md` and
> `docs/SECURITY_COMPLIANCE_FOUNDATION.md` still open by scoping themselves
> to that removed app — their substance mostly stands, their scope lines do
> not. Read them with that correction in mind until they are rewritten.

---

## 1. What we actually are

A currency exchange is a **regulated cash business**. Our customers are money
services businesses. In Canada that means FINTRAC: they must know who they
serve, keep those records for five years, report large and suspicious
transactions, and produce all of it on demand.

Three consequences follow, and almost everything below is downstream of them:

1. **We hold other people's compliance record.** Not a convenience copy — the
   record. If we lose it, our customer fails an examination.
2. **A desk that cannot open is a shop that cannot trade.** Not a degraded
   experience: a closed business, with staff standing around.
3. **Our panel is the keys to every desk.** One compromised platform account
   reaches every customer's client list. The blast radius of our own security
   is larger than the blast radius of theirs.

We are not building a CRM. The bar is the bar for systems that hold money and
identity documents, and it does not scale down because we are small.

---

## 2. The shape of the system

```
                      one origin, one process
  ┌───────────────────────────────────────────────────────────┐
  │  Fastify                                                  │
  │                                                           │
  │  /            marketing site (built from designs)         │
  │  /app         the OS — the product a teller uses          │
  │  /admin       the platform panel — our side               │
  │  /api/*       everything below                            │
  └───────────────────────────────────────────────────────────┘
            │                                    │
            │ Drizzle + Zod                      │ pg + hand-written SQL
            ▼                                    ▼
  ┌──────────────────────┐            ┌───────────────────────┐
  │  Platform & tenancy  │            │  The ledger           │
  │  tenants, staff,     │            │  double-entry, money  │
  │  sessions, audit,    │            │  Decimal, idempotent, │
  │  onboarding, billing │            │  row-locked           │
  └──────────────────────┘            └───────────────────────┘
```

One origin for app and API, so session cookies work with no CORS
configuration and no token sitting in browser storage to be stolen. That is a
security decision, not a convenience one.

**Two persistence disciplines, deliberately.** Drizzle where the shape changes
often and the types matter more than the SQL; raw `pg` in the ledger where we
need `FOR UPDATE`, `SERIALIZABLE`, and exact control over the statement. The
cost is that no transaction spans both, so anything touching both must be
ordered such that a failure halfway leaves a recoverable state rather than a
broken one. Where that ordering matters it is commented at the call site.

**The frontend ships without a build step for its logic** — JSX compiled
ahead of time into `web/app/`, React served from our own origin, no CDN in
the request path for anything the product needs to open. (One exception
remains: the Tailwind Play CDN, a compiler running in the customer's browser.
It is on the list in §8.)

---

## 3. The rule: a table, or a document

This is the decision the codebase currently gets wrong, and the one worth
being most precise about.

Today a desk's working state is one JSON document per tenant — around
twenty-six keys, written whole by the browser every few seconds. It holds
window positions *and* the client KYC file. Those two things do not belong in
the same place, and the reason is not tidiness.

> **A table is for anything a regulator, an auditor, a court, or an angry
> customer could ask about. A document is for anything only the screen cares
> about.**

Apply it and the answers fall out:

| | Where | Why |
|---|---|---|
| Clients, ID evidence, risk ratings | **Table** | Five-year retention, must be queryable, must be provable |
| Transactions | **Table** | Money. Already relational in the ledger — the blob is a stale second copy |
| Till counts, cash movements | **Table** | Reconciliation evidence |
| Compliance flags, LCTR/STR filings | **Table** | The thing an examination is *about* |
| Window positions, app order, hidden apps | **Document** | Genuinely per-person UI preference |
| Draft text not yet sent | **Document** | Nobody audits a draft |

The mistake to avoid is the opposite over-correction: relationalising the
window manager. A document is the right shape for preferences, and forcing
them into columns buys nothing and costs a migration every time the UI moves.

**Four properties a table gives us that a document cannot:**

1. **Identity.** Every row has an id that never changes. Today clients are
   keyed by the customer's *name* — so two people called David Chen are one
   client, and correcting a typo orphans somebody's transaction history.
2. **Constraints.** The database refuses impossible data. A document accepts
   whatever the browser sends, including whatever a half-deployed client
   sends during a rollout.
3. **Concurrency.** Two tellers can write different rows at once. Two
   browsers cannot write the same document at once without one of them
   losing — silently, which is how it works today.
4. **Query.** "Every transaction over $10,000 in the last five years" is a
   `WHERE` clause against a table, and a full download plus a loop against a
   document.

### How we get there: strangle, don't rewrite

A big-bang migration of a live desk is how customers lose data. Instead:

1. **Describe** the document — a typed schema per key, validated on write.
   You cannot promote what you cannot describe, and validation immediately
   catches the drift already there.
2. **Identify** — give every entity a stable id, assigned once and migrated
   on read, while it still lives in the document.
3. **Promote** one entity at a time into a table. The server becomes
   authoritative for it; the document keeps a read copy so an older client
   keeps working.
4. **Cut over** the client to read the table directly.
5. **Delete** the key from the document.

Each step ships on its own and is reversible. The document shrinks to what it
should always have been: this person's preferences on this screen.

---

## 4. Keeping our customers' customers safe

The most valuable thing in this system is not our code and not our revenue.
It is a list of real people, their addresses, their dates of birth, their
identity documents, and a record of every time they moved money. That is
worth more to a criminal than the cash in the till.

**Tenant isolation is structural, never remembered.** Every scoped query
derives its tenant from the session — `resolveSession` returns it, the
handler uses it. A tenant id supplied by the caller is never trusted to scope
a read. There is one exception today (login accepts a tenant hint to
disambiguate an address across desks) and it is bounded to identity
resolution, never to data access. **Any new endpoint that takes a tenant id
in the body or query is wrong by default** and needs a comment justifying why
it is the exception.

**Hold as little as possible.** Every field we store is a field we can lose.
Before adding one, ask what breaks if we do not have it. Photographed ID is
the sharpest case: we need to know it was *sighted and verified*, which is not
the same as needing to keep the image forever.

**Secrets are never at rest in a replayable form.** Passwords are scrypt with
the cost parameters stored inside the hash, so they can be raised later
without invalidating anyone. Session tokens are stored as SHA-256 — a
database leak cannot be replayed as a login. One-time codes are hashed and
compared in constant time. Till PINs were once in the state blob the browser
downloads whole; they live hashed on the staff record now, and the write path
strips them on every save so an older client cannot put one back.

**Sessions die on command.** Opaque tokens in an httpOnly cookie, not JWTs. A
JWT stays valid until it expires no matter what happened in between, and at a
cash desk the interesting event is somebody being let go at 4pm. Every
credential change revokes every other session.

**Nothing enumerable.** Whether an account exists is not public. The reset
route answers identically for a stranger and a customer, in the same words —
and the rate limit answers identically too, because a throttle that only
fires for real accounts is a slower way of asking the same question.

**The record of who did what is append-only.** `audit_events` gets a row for
every credential action and every privileged act. Issuing somebody's sign-in
code from the panel is deliberately not a quiet thing.

---

## 5. Keeping the company safe

Our customers' security is a compliance obligation. Ours is an existential
one.

**The panel is the crown jewels, and it is one password deep.** Platform
membership is a table with roles and per-route permissions, every action
audited — that part is right. What is missing is a second factor. One phished
password reaches every desk we run. This is the highest unpriced risk in the
system, and the fact that a desk owner has two factors while we do not is
backwards.

**Least privilege on our own side.** Support does not need the permission
that suspends a desk. The default for a new platform capability is "the role
that obviously needs it", not "admin".

**Secrets live in the host environment. Never the repo, never the browser,
never the panel.** Stripe keys, the Resend key, the database URL. No screen
displays a secret, including to us. Rotation happens in the host; nothing in
Git ever needs to change.

**The deploy is an attack surface.** CI rebuilds `web/` and fails if the
committed output differs, so what a customer runs is what the sources say.
Browser dependencies are pinned exactly — a caret on a browser dependency is
an unreviewed change in production. Integrity hashes must match the version
actually served; we have already had a page render as a black rectangle
because they did not.

**Blast radius is a design input.** Of any new capability, ask: if this
credential leaks, how many customers are affected? A per-tenant key that
leaks is an incident. A platform key that leaks is the company.

---

## 6. Building in the age of AI

Most of this code was written with AI assistance. That changes what a good
architecture *is*, and pretending otherwise produces a codebase that looks
fine and rots.

**The bottleneck moved.** Producing a thousand correct-looking lines is close
to free. Knowing whether they are *right* is not. So effort moves out of
writing and into whatever makes wrongness visible: types, constraints, tests
that encode intent, and comments that say why.

**Correctness must be structural, not remembered.** A convention holds
because a human remembers it. Fast assisted change does not remember — it
pattern-matches on the code in front of it. Therefore:

- Authorization belongs where it cannot be skipped, not in a line at the top
  of each handler that a new route can silently omit.
- Constraints belong in the database, where no code path can route around
  them.
- Anything that must be true of every route is a hook, not a habit.

The test: *if the next change is made by someone with no context, does the
system stop them from getting it wrong, or does it merely hope?*

**Comments say why, including what failed.** This repo does it well and it
must continue. When a fix had two plausible approaches and the obvious one
did not work, the code says so — otherwise the next reader, human or model,
re-derives the same dead end. Real examples already in here: why a
panel-issued code must be the same code the customer's screen accepts; why
the not-found handler distinguishes a page from a script; why a build was
deleted that CI was happily testing.

**Blobs are where assisted code rots.** `z.record(z.unknown())` type-checks
against everything and therefore verifies nothing. Every generated line
touching it compiles, and the drift stays invisible until a customer finds
it. Schemas at the boundary are worth more now than they have ever been.

**Tests are the specification.** When code is cheap and intent is expensive,
the test is where intent lives. Ours read as prose about behaviour — *"kills
the one before it, so 'ask for another' is always safe advice"* — because
that sentence survives a rewrite of the implementation and a bare assertion
does not.

**Verify against the running thing.** An assistant's confident description of
what code does is a hypothesis. The 1 MiB ceiling in §8 was found by sending
a 1.5 MB body to a real server, not by reading the handler — which *said* the
limit was 4 MB and was wrong. Measure, then claim.

### When a model touches customer data

Not wired yet: the Assistant in the OS is a mock, and there is no model API
call anywhere in the codebase. **That makes now the only cheap moment to set
the rules**, before there is an integration to retrofit.

1. **A model is a third-party processor.** The moment a customer's client list
   reaches an external model, that is a sub-processor relationship with
   disclosure obligations and a contract behind it. A commercial and legal
   decision, not a library import.
2. **Model output is never authority.** A model may draft, summarise, suggest,
   rank. It may not post a transaction, change a rate, approve a customer,
   file a report, or move money. Every privileged action stays behind the same
   deterministic permission check a human action goes through, with the human
   named as the actor.
3. **Everything in the context window is untrusted input.** A customer's name,
   a transaction note, an uploaded document — all attacker-controllable text.
   Assume anything a model reads is trying to instruct it. Never let model
   output select a privileged tool call without an independent check that the
   *user* was allowed to do that thing.
4. **Minimise what goes in.** Send the fields the task needs, not the record.
   A summarisation task does not need a passport number.
5. **Log the prompt and the completion** for anything that touched customer
   data, into the same audit trail as everything else. "The AI did it" is not
   an answer to an examiner.

---

## 7. What "done" means here

A change is done when all of these hold. The codebase is already close to
this; it is written down so it does not slip.

- **It works against the running system**, verified by using it, not by
  reasoning that it should.
- **The failure path is as designed as the success path.** What does the
  person see when it breaks? "Nothing, and it retries forever in silence" is
  a bug, not a fallback.
- **A test encodes the intent**, in language about behaviour rather than
  implementation.
- **The comment explains why**, especially where the code looks odd, and names
  the approach that did not work if one was tried.
- **It cannot silently do the wrong thing.** Prefer a loud refusal to a quiet
  guess, everywhere money, identity or authorization is involved.
- **The gates are green**: server tests, the parse gate over every browser
  file, the built output current with its sources, the customer journey walked
  end to end.

---

## 8. What we know is wrong, in the order we are fixing it

An honest list. Writing it down is what stops these from becoming
architecture by default.

**Now**

1. **Silent save failure.** The state size guard says 4 MB and can never fire
   — no body limit is configured, so Fastify's 1 MiB default rejects first,
   and the client retries the same doomed payload every four seconds forever
   without telling anyone. Confirmed by probe, not by reading.
2. **Last-write-wins on the whole desk.** No version, no precondition. Two
   tellers, and one loses work with no error anywhere.
3. **The document has no shape.** `z.record(z.unknown())` — anything is
   accepted.
4. **No stable identity.** Clients keyed by human name; transaction ids
   assigned client-side as sequential integers, so two tellers collide.

**Next**

5. Promote clients, then transactions, then till counts, into tables.
6. **Platform MFA.** One password between a phished account and every desk.
7. Four in-memory maps assume exactly one process — no horizontal scale, and
   every deploy drops in-flight sign-ins.
8. Authorization moves from a remembered line to a hook.

**After**

9. One schema mechanism. The boot-time DDL string and the checksummed
   migrations describe the same tables two ways, and the migrations do not run
   on the embedded database at all — so dev and production run different
   schemas.
10. The Tailwind CDN compiler still runs in the customer's browser.
11. A state layer in the OS. Thirty localStorage keys read directly from
    fifteen files, modules wired through a global, thirty-prop components. A
    velocity tax rather than a correctness risk, which is why it is last.
