# The Road to Deployment

Two bars, scored separately, because they are different questions and a
single percentage hides which one you are looking at.

| | what it means |
|---|---|
| **Bar 1 — One shop** | A desk opens, trades all day, closes with books that balance. Nobody reaches for a workaround. The founder is one phone call away. |
| **Bar 2 — Any shop** | The same, for a shop nobody has met, that signed up on a Tuesday and was never trained. Nobody is standing behind it. |

Bar 1 is the deployment decision. Bar 2 is the business.

## The gate

`tests/e2e/zz-a-day-at-the-desk.spec.ts` is the one test that answers Bar 1.
It runs a shift — open the drawer, put a customer on file, exchange,
remit, cash a cheque, get refused at the identification line, count the
drawer, close, sign off — and its last assertion is the only one that
matters:

> what the ledger says is in the drawer equals what the test worked out
> independently from the opening float and every movement since.

That is the arithmetic a shop owner does on paper at closing. **If it
fails, nothing else being green matters.** It passes today.

## How these numbers were arrived at

Scored from **positive evidence** — a route driven, a value read back off
the server, a test that fails when the thing breaks. Not from the absence
of a grep hit.

That distinction is here because it has already cost us once: the Rate
Board was scored 25% and named the next priority on the strength of a
search that found nothing inside one HTML file. The file loads two
scripts that do all the work. It is ~80%, it was always ~80%, and the
recommendation built on top of it would have spent a week rebuilding
something that existed. **A grep that finds nothing proves nothing.**

---

## Where each app stands

| App | Bar 1 | Bar 2 | What is between it and 100 |
|---|---|---|---|
| Till | 95 | 90 | Standalone (no-server) mode shows no expected float |
| Ledger — deals | 92 | 85 | Headline figures still computed in the browser (#31) |
| Rate Board | 85 | 80 | Poll-over-time and provider sync unverified |
| Cheques | 90 | 80 | Cheque images still local to one browser |
| Clients / KYC | 90 | 78 | ID scans in Postgres, not object storage (#29) |
| Dashboard | 90 | 85 | — |
| Vault | 88 | 70 | Inter-branch runs blocked on branch IDs (#10) |
| Reports | 85 | 80 | — |
| Transfers | 85 | 75 | Status lifecycle still browser-only |
| Pricing | 80 | 75 | — |
| Compliance | 80 | 65 | Aggregate engine computes in the browser over local rows |
| Settings | 75 | 65 | Most settings still `localStorage` |
| Audit trail | 40 | 25 | Shows a 300-item in-memory array, never reads `ledger_audit_events` |
| Branches | 60 | 30 | Browser-invented IDs; no server records (#10) |
| Telegraph | 50 | 35 | `localStorage` only |

**Bar 1: ~85%. Bar 2: ~70%.**

Note how differently the two columns treat the same code. The Audit app
is bad under both. Branches barely matters for one shop and is a blocker
for many. That gap *is* the roadmap.

## Where each process stands

| Process | Bar 1 | Bar 2 | Gap |
|---|---|---|---|
| Password recovery | 95 | 90 | — |
| Login / roles / sessions | 90 | 85 | — |
| Sign-up → provisioning | 90 | 80 | — |
| Onboarding (64 screens) | 85 | 75 | Some answers land in `setup` and drive nothing |
| **Billing (Stripe)** | 60 | **40** | Two tests. Failure here locks a paying shop out |

---

## What is left, in the order it should be done

### Before a shop opens (Bar 1)

1. **Billing hardening.** Two tests cover the path that takes money and
   controls access. A shop locked out by a billing bug on a Saturday is
   the worst first impression available. *Largest single risk on this
   list.*
2. **The Audit app reads the real trail.** `ledger_audit_events` has
   carried every consequential action for months and the screen has never
   shown it. The day an examiner asks, the answer must not be a browser
   array capped at 300 entries.
3. **Run the gate against a fresh tenant**, not the demo desk — a real
   shop starts from provisioning, not from a seed.

### Before the second shop (Bar 2)

4. **One ID space for branches and tills** (#10). The browser invents
   branch identifiers, which blocks inter-branch vault runs and is
   incoherent the moment there are two locations.
5. **The compliance aggregate moves to the server.** It computes in the
   browser over local rows today. It works — and it is the exact
   two-books shape that has produced five defects this year.
6. **Ledger headlines read `/api/ledger/summary`** (#31) — same reason.
7. **ID scans and cheque images to object storage** (#29).
8. **A demo tenant provisioned server-side** (#28) — you cannot sell what
   you cannot demonstrate.
9. **Test isolation** (#33), and the product defect underneath it.
   Several routes resolve which till a request is for as *"the only
   workspace at this branch"* — true of a one-till desk and of nothing
   else. Adding a single extra till to the demo branch during a test run
   produced ten failures, because every caller that does not send an
   `x-workspace-id` header is denied the moment a second workspace
   exists. The browser always sends the header, so a shop does not see
   this today; a shop with two counters and any integration that does not
   set it would. The fix is for a session to resolve to the teller's own
   till rather than to whichever one happens to be unique — and until it
   lands, the day-at-the-desk gate is named `zz-` so it runs after the
   suites it would otherwise disturb. That prefix is a workaround with a
   shelf life, not a convention.

## The rule that keeps this honest

Every item above is done when a test fails if it regresses — not when the
code exists. That standard is why the cash defects were found, and
skipping it is why the Rate Board was scored wrong.
