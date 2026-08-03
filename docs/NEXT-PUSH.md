# The next push

Rewritten 2026-08-03, after auditing every guidance doc in `docs/` against
the code. The previous version described a push that shipped, plus two more
after it.

Everything below was **checked in the code or in a browser**. Where something
is a guess it says so.

---

## Shipped since the last version of this file

Three pushes, all merged to `main`.

| | |
|---|---|
| **Forgot password, end to end** | Ask from sign-in → six-digit code, fifteen minutes, five guesses → new password → every device signed out. A stranger and a customer get the same answer, in the same words, and the rate limit answers the same way too. |
| **The sign-in screen** | The rehearsal desk's staff are marked `demo` and never offered to a real customer. Both dead ends ("the owner can reset it" — they *are* the owner) open the reset flow. |
| **A4 · contact auto-reply** | Somebody writing in gets an acknowledgement with their reference, in the designed style. |
| **Two of three 404s** | Gone. The third is deliberate — see below. |
| **Two minutes between codes** | `/api/auth/login/start` had **no send limit at all**. One shared gap now, across all four routes that send codes. |
| **One press, one email** | `disabled` can't stop a double-click — React state isn't synchronous. Every send latches on a ref set *before* the await. Verified by triple-clicking the real button. |
| **The state size guard that could never fire** | It refused at 4 MB; no body limit was configured, so Fastify's 1 MiB default rejected first. Found by sending 1.5 MB to a running server. The client retried the same doomed payload every four seconds, silently, forever. |
| **Two tellers stopped overwriting each other** | Versioned saves; a stale one is refused and merged key by key. |
| **The desk document has a shape** | 44 keys catalogued, 29 compliance-bearing. Describes, never refuses — the browser holds the only copy. |
| **The last CDN is gone** | Tailwind compiled at build time. Verified signed in with the CDN host blocked: 67/67 flex elements styled. |
| **A3 · sign-in code** | Now renders the design, through the same helper the reset email uses. It was the most-seen email in the product and the last one still plain. |
| **The fake `000000` screen** | Deleted. Already unreachable, still compiled into every customer's bundle. |

---

## What already works, so nobody re-checks it

- Applying → review → acknowledgement, on its own.
- Approving in one press → the invitation with reference and setup link.
- Setup → confirmation code → desk built → landed inside it, signed in, with
  their own shop's name on it and nothing on the ledger.
- A returning owner signing in from a cold browser: email, password, emailed
  code — typed on a keyboard, not only the on-screen keypad — station picker,
  desk.
- Forgot password, end to end.
- The Inbox, the compose page, the sample sender, the Emails page.
- Every public page and every internal link: no broken links, no broken
  images, and **no soft-404s** — specifically tested, because the not-found
  handler serving the front page is what makes a broken link invisible.
- The desk opens with every third-party host blocked.

### The one 404 left, and why

`<img src="{{ p.src }}">` on the front page. The browser's preload scanner
fetches that literally before any JavaScript runs; the design's runtime
substitutes the real path a tick later and the image loads.

Silencing it means renaming the attribute in the design's markup and copying
it back after the runtime resolves it — a real risk to the front page's
imagery for one line in a console nobody but us opens. Left deliberately.

---

## P0 · The compliance record is in a browser-written document

**This is the next push.** Everything else on this list is smaller.

`cdos_clients_v1` holds every customer, their ID type and number, expiry,
address, date of birth and risk rating. It lives in the state document — no
table, no `/api/clients`, nothing on the server that knows a customer exists.

Two things make it worse than "not migrated yet":

1. **Clients are keyed by the person's name.** `seedClients()` returns
   `{ 'Jakob Miller': {...} }` and transactions join by that string
   (`row.customer`). Two people called David Chen are one client. Correcting
   a spelling orphans somebody's transaction history.
2. **Transaction ids are client-assigned integers** — `id: 1, 2, 3`. Two
   tellers posting at once collide.

The per-key merge shipped last push makes the common two-teller case safe,
and there's a test recording exactly where it doesn't: both editing the same
key still loses one side, and every transaction lives in one key.

**Build:** `desk_clients` with a real id → migrate name→id on read → cut the
joins over → delete the key. `docs/ARCHITECTURE.md` §3 has the strangle path;
this is the first entity through it, so the pattern it establishes is worth
more than the entity.

---

## P1 · One password guards every desk we host

Platform team membership is a table with roles, every route gated, every
action audited — that part is right. There is no second factor.

A desk **owner** signs in with a password and an emailed code. We sign in
with a password. That is backwards, and the blast radius is not one desk, it
is every customer's client list.

The machinery already exists: `login/start` + `login/verify`, the cooldown,
the code storage. This is wiring, not invention.

---

## P2 · Money

Neither is a bug; both are load-bearing for what the site and the emails
already promise.

- **Payment gates nothing.** `POST /api/onboarding/:ref/launch` creates the
  desk without asking about a card. Checkout and the customer portal both
  exist and the in-OS plan cards call them — nothing depends on the result.
- **⛔ Blocked on a decision, not on code:** what "three months free" means
  mechanically. Trial with a card on file, a 100%-off coupon for three cycles,
  or a delayed subscription start? That answer decides the checkout call and
  A2's payment copy. It has been open a while and it blocks the whole of P2.

---

## P3 · The rest of the document

Same pattern as clients, once clients has established it.

- **Cheques and transfers** — document-only.
- **The Texts inbox** — `cdos-telegraph.jsx` makes no server call at all.
  `rate_quotes` exists and nothing reads it; there is no `quote_messages`
  table. The last app that has never spoken to the server.
- **Export & backup** of a tenant's own data.

---

## P4 · Known, deliberate, not urgent

Written down so nobody spends an afternoon rediscovering them.

- **York FX is seeded on every boot**, and `tenantId` defaults to
  `"tnt-yorkfx"` in the login schema. Harmless today — email and CurrencyDesk
  ID resolve a person on their own — but the demo tenant is baked into the
  platform's auth as everyone's fallback. Remove both together when the
  rehearsal desk stops earning its keep.
- **Four in-memory maps assume one process** (login challenges, reset
  throttle, code cooldown, the platform-member cache). No horizontal scale,
  and every deploy drops in-flight sign-ins.
- **Two schema mechanisms.** A boot-time DDL string and checksummed
  migrations describe the same tables two ways, and the migrations don't run
  on the embedded database at all — so dev and production run different
  schemas. CI covers it with a real Postgres; the daily loop doesn't.
- **Authorization is a remembered line**, not a hook. Correct today — checked
  route by route — but one forgotten `gate()` is a full platform breach.
- **Google Fonts** is the last off-domain request. Degrades to fallback fonts;
  half an hour to self-host, same as the site already does.

---

## Suggested order

1. **Clients into a table** — the compliance record, and the pattern for
   everything after it.
2. **Platform MFA** — cheap, and it's the risk that ends the company rather
   than costs it a customer.
3. **Answer the billing question**, then let payment gate launch.
4. Cheques, transfers, Texts — repeat the pattern.

That is a coherent run: **the record becomes real, our own door gets a second
lock, and the thing we sell can be charged for.**
