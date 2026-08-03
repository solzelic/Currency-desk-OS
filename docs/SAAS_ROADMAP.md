# CurrencyDesk — Multi-tenant SaaS build plan

The plan to turn CurrencyDesk from a single seeded demo into a real product
where an exchange shop **signs up, gets a brand-new empty instance, and runs
their business on it** — with data that's live, server-side, and isolated per
tenant.

> **Status re-checked against the code on 2026-08-03.** Every ✅ below was
> verified by reading the route or the component, not by trusting the last
> update. Written 2026-07-21; most of A, C and D shipped in between, and this
> was still describing them as unbuilt.

---

## North star (definition of done)

| | | |
|---|---|---|
| 1 | A new shop signs up and gets their **own blank tenant** | ✅ |
| 2 | They and their staff **log in**; nothing leaks between tenants | ✅ |
| 3 | Everything operational is **stored on the server**, survives a wipe, same on every terminal | 🟡 **the remaining gap** |
| 4 | Billing is real: a plan is a paid subscription | 🟡 checkout works, nothing gates on it |

Three of the four are done or close. **Item 3 is the whole remaining job**,
and it is narrower than it was: the ledger, till and quotes are server-backed;
clients/KYC, cheques, transfers and the Texts inbox are not.

## Current state (verified inventory)

**Server-side and working:** tenants, legal entities, branches, workspaces,
per-employee auth + sessions (with an emailed second factor and self-serve
password reset), staff admin, rate boards + market rates, the Postgres ledger
(`/api/ledger/*`), quotes (`/api/quotes`), till sessions and counts
(`ledger/till-control.ts`), Stripe customers/subscriptions/invoices/events,
audit events, and the per-tenant state document (`/api/tenant/state` — now
versioned, size-guarded and shape-described).

**Still browser-local — the gap, precisely:**

| | Where it is | Server side exists? |
|---|---|---|
| Clients / KYC | `cdos_clients_v1` in the document | ❌ no `/api/clients` at all |
| Cheques | `cdos_cheques_v1` | ❌ |
| Transfers | `cdos_transfers_v1` | ❌ |
| Texts inbox + threads | `cdos_tg_*` | 🟡 `rate_quotes` exists; the app never calls it |
| Ledger book | `cdos_rows_v1` | ✅ **but doubled** — server rows are authoritative and merged in the browser |
| Till counts | `cdos_till_*` | ✅ server-backed when signed in |
| Settings | `cdos_settings` | 🟡 in the document, which is now typed and versioned |

`docs/ARCHITECTURE.md` §3 has the rule for which of these become tables and
which stay a document, and the strangle path for getting there.

**No longer true:** "one tenant, hardcoded." Signup creates real tenants and
the onboarding flow provisions them. York FX is still seeded on every boot,
but as the demo desk rather than the only one — and the persistence bridge
deliberately skips it so the rehearsal desk can't be dirtied.

---

## Key architectural decisions (resolve these first)

### D1 — How does login know which tenant? **→ recommend: workspace slug + email**
Options: (a) subdomain `yorkfx.currencydesk.app` (clean, needs wildcard DNS +
routing), (b) workspace slug typed at login, (c) email is globally unique →
resolves tenant. **Recommendation:** each tenant already has a `site_slug`;
serve the OS per-tenant (`/app/<slug>` or their custom domain) and make **email
the login identity** (unique per tenant), so staff log in with email + password
and the tenant comes from the URL. Keeps the door simple, no DNS magic to ship
v1. Subdomains can come later.

### D2 — How is operational data stored? **→ recommend: hybrid**
- **Relational tables** for money & compliance data — ledger, clients/KYC,
  quotes, till/vault, cheques, transfers. These must be queryable, auditable,
  and are the system of record. (The Postgres ledger already is.)
- **Per-tenant JSON store** (one `tenant_state` table, keyed by the existing
  `cdos_*` keys) for settings, UI config, roster prefs, Texts templates —
  things that are just "the shop's configuration." This lets us swap the
  front-end's `localStorage.get/set` for server calls with minimal rewrite.

Rationale: don't rebuild 26 localStorage domains as relational tables; only the
ones that need it. Fastest path to "data is live everywhere" without
over-engineering config.

### D3 — What does "the store" mean? **→ needs your answer**
(a) a public signup site where shops onboard themselves, or (b) listing
CurrencyDesk as a product somewhere. This plan assumes **(a)** — self-serve
signup — as the finish line. Confirm.

---

## The plan, in phases (dependency order)

### Phase A — Auth, signup & instance creation ✅ **done**

- ✅ `POST /api/signup` creates tenant, legal entity, branch + till, owner
  (scrypt), unique slug, audited.
- ✅ Email is the login identity. `findLoginUser` resolves an address across
  desks, and a CurrencyDesk ID (`CD-YORK-0042`) resolves on its own.
- ✅ `tenantId` comes from the session on every scoped route — never from the
  caller. Checked route by route; the one exception is a login *hint* to
  disambiguate an address, which never scopes a read.
- ✅ Public application at `/signup`, invite, emailed code, setup, desk created.
- ❌ **York FX is still seeded on every boot** (`server/src/index.ts`). Not
  the "global default" any more — signup and onboarding both create real
  tenants — so this is now cosmetic rather than blocking. Worth doing when the
  demo desk stops being useful for rehearsals.
- ⚠️ **`tenantId` still defaults to `"tnt-yorkfx"`** in `loginBody`. Harmless
  today because email and CD-ID resolve on their own, but the demo tenant is
  baked into the platform's auth schema as everyone's fallback. Remove it when
  the seed goes.

**Not done and worth deciding:** the login page does not resolve a tenant from
the URL (`/app/<slug>`). It hasn't needed to — identity resolves the desk.
If two people ever share an email across desks, this becomes real.

### Phase B — Make the data live 🟡 **half done, and the half that's left is the compliance half**

- ✅ The per-tenant document exists — but as **one blob**, not `GET/PUT
  /api/state/:key`. It is now versioned (stale saves refused, merged key by
  key), size-guarded with a loud failure, and shape-described: 44 keys
  catalogued, each marked `record` or `preference`.
- ✅ **The OS Ledger is wired to the Postgres ledger.** Posting goes through
  quotes → `postFrozenQuote`; the browser merges server rows over local ones.
- ✅ **Till sessions and counts are server-backed** (`ledger/till-control.ts`,
  `serverBacked` throughout `cdos-till.jsx`).
- ❌ **Clients / KYC — nothing.** No table, no `/api/clients`. Worse than
  absent: clients are keyed by the customer's *name*, so two people called
  David Chen are one client, and correcting a typo orphans a transaction
  history. **This is the next push.**
- ❌ Cheques, transfers — still document-only.
- ❌ **Texts inbox is not live.** `cdos-telegraph.jsx` makes no server call at
  all. `rate_quotes` exists; nothing reads it. No `quote_messages` table.
- ➖ The `cdosStore` shim was never built and is no longer the plan.
  `docs/ARCHITECTURE.md` §3 supersedes it: promote entity by entity into real
  tables, leave genuine preferences in the document.

**The honest read:** the money path is server-authoritative. The *compliance*
path — who the customer is, what ID was sighted, what was filed — is still a
JSON document written last-write-wins by a browser. For a business whose
regulator can ask for five years of exactly that, this is the gap that
matters, and it's the only one on this list that would hurt in an examination.

### Phase C — First-run reality ✅ **done**

- ✅ First-run detection — `hydrateTenant` returns `empty` and seeds a fresh
  slate from the desk's own answers.
- ✅ The setup flow runs on the emailed link and provisions the desk from what
  they typed.
- ✅ A new desk opens on its own name and city, with nothing on the ledger.
  Walked end to end in a browser; it's the e2e suite's main path.

### Phase D — Billing & the store 🟡 **built, but nothing depends on it**

- ✅ Stripe customers, subscriptions, invoices and events are modelled and
  webhook-driven (`checkout.session.completed`, `invoice.paid`).
- ✅ `POST /api/billing/checkout` and `/api/billing/portal` exist, and the
  **in-OS plan cards call them** (`cdos-settings.jsx`).
- ✅ The marketing site and application flow are live.
- ❌ **Payment gates nothing.** `POST /api/onboarding/:ref/launch` creates the
  desk without asking about a card. Today the promise "the first three months
  come to zero" is kept by accident — nothing is charged at all — which stops
  being true the moment billing is switched on.
- ⛔ **Blocked on a decision, not on code:** what "three months free" means
  mechanically — trial with a card on file, a 100%-off coupon for three
  cycles, or a delayed subscription start. That answer decides both the
  checkout call and A2's payment copy. It has been open for a while.

### Phase E — Production hardening 🟡

- ✅ **Real second factor.** An emailed six-digit code on every sign-in, with
  a two-minute gap between sends and one email per press.
- ✅ The fake `000000` screen is gone — it had already been unreachable, but
  it was still compiled into the bundle every customer downloads.
- ✅ Self-serve password reset that revokes every session.
- ✅ Cross-session safety for the document: versioned saves, per-key merge.
- ❌ **Platform MFA — the highest unpriced risk in the system.** One phished
  password reaches every desk we host. A desk owner has two factors and we do
  not, which is backwards.
- ❌ Export & backup for a tenant's own data.
- ❌ FINTRAC submission pipe, maker-checker approvals, retention. *(later)*
- ⛔ SMS / voice: blocked on corporate paper → Twilio number. The ElevenLabs
  outbound caller is roughly a day's work once a number exists; building it
  before then produces code nothing can dial.

---

---

## What's actually left, in order

The original sequence (A → B → C → D → E) is spent: A, C are done, D is built
and waiting on one decision. What remains is the back half of B plus two items
from E, and it reorders by risk rather than by phase.

1. **Clients / KYC into a table.** The compliance record is the last thing
   still living in a browser-written document, and clients have no stable
   identity. Biggest correctness win left, and the prerequisite for the rest
   of B.
2. **Platform MFA.** One password between a phished account and every
   customer's client list.
3. **Decide "three months free"**, then let payment gate launch. A decision,
   then a day.
4. **Cheques and transfers into tables** — same pattern as clients, once that
   pattern exists.
5. **The Texts inbox onto `rate_quotes`** — the last app that has never spoken
   to the server.
6. Export & backup; then the deferred compliance machinery (FINTRAC pipe,
   maker-checker, retention).

**Blocked on paper, not on us:** the Twilio number, and therefore the voice
agent.

## Effort key
S ≈ hours · M ≈ a day · L ≈ multiple days · XL ≈ a week+.
