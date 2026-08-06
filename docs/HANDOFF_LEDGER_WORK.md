# Handoff — the ledger workstream

Branch `claude/till-wiring-money-flow-garwho`, pull request **#27**. Read
this before touching anything; it is the record of what was learned the
expensive way.

---

## 1. The one rule

**There is one book, and it is the server.** The browser renders cash; it
never computes it. Every serious defect this project has had came from
somewhere that broke this rule, and there were many — see
`docs/CASH_OWNERSHIP_INVARIANTS.md`, which is the most important document
in the repository.

Corollaries that are already enforced and must stay enforced:

- Every money movement is one server call, in one database transaction,
  with an idempotency key.
- The **book names things** — transaction references, obligation
  references, idempotency keys. The browser counting its own local list
  to build an identifier caused silent data loss; do not reintroduce it.
- A figure the ledger cannot answer is shown as **absent**, never as
  zero. `docs/ABSENT_FIGURES.md`.
- A cash figure is **cash that crossed the counter**, which is not the
  same as the size of the deal on two of the six product lines.

## 2. How to build and verify

```bash
# after editing anything in os-src/ — web/app/os.js is GENERATED, never edit it
npm run build:os
npm run check:parse

# server suite (needs PostgreSQL 16; ~680 tests, ~3 min)
cd server && TEST_DATABASE_URL=postgres://…/freshdb npm test

# browser suite (~68 tests, ~2.5 min)
SEAM_DATABASE_URL=postgres://…/freshdb npx playwright test
# if Playwright cannot find a browser, point PW_CHROMIUM at a chrome binary
```

**Use a fresh database for each full run.** These suites share one and
several of them leave state behind — see §5.

Adding a migration means **three** places, and missing any one of them
fails silently:

1. `server/src/db/migrations/NNN_name.sql`
2. register it in the list in `server/src/db/migrations.ts`
3. if it touches a Drizzle-managed table, add the column to the `DDL`
   constant in `server/src/db/index.ts` **and** to `server/src/db/schema.ts`

Ledger tables are the exception — they are created by
`server/src/ledger/migration.sql` and are deliberately absent from `DDL`.

## 3. The gate

`tests/e2e/zz-a-day-at-the-desk.spec.ts` runs a full shift and its final
assertion compares the ledger's drawer against arithmetic the test keeps
independently. **If that fails, nothing else being green matters.** Run
it before and after any change to a money path.

The `zz-` prefix makes it run last. That is a workaround, not a
convention — see §5.

## 4. What to do next, in order

### Before a shop opens

1. **Run the gate against a freshly provisioned tenant.** Today it runs
   against the seeded demo desk. A real shop arrives through
   `server/src/onboarding/provision.ts`, and nothing currently proves
   that a desk created that way can actually trade. Cheapest of the
   three and the one most likely to find something.
2. **Billing.** `server/tests/billing.test.ts` has two tests covering the
   path that takes money and controls access. A shop locked out by a
   billing bug is the worst possible first impression.
3. **The Audit app reads the real trail.** `ledger_audit_events` has
   recorded every consequential action for months;
   `os-src/cdos-modules.jsx` `Audit()` renders a `useState` array capped
   at 300 entries that never touches it.

### Before the second shop

4. One ID space for branches and tills — the browser invents branch
   identifiers, which blocks inter-branch vault runs.
5. The compliance aggregate moves server-side (`aggClusters` in
   `os-src/cdos-compliance.jsx` computes over local rows).
6. Ledger headline figures read `GET /api/ledger/summary`.
7. ID scans and cheque images to object storage.
8. A demo tenant provisioned server-side.
9. Test isolation, and the product defect under it — §5.

`docs/ROAD_TO_DEPLOYMENT.md` scores every app and process against two
separate bars and explains the reasoning.

## 5. Traps that have already cost days

**Several routes resolve which till a request is for as "the only
workspace at this branch."** True of a one-till desk and nothing else.
Adding one extra till to the demo branch during a test run took the
browser suite from 2 failures to 10, because every caller that does not
send an `x-workspace-id` header is denied once a second workspace
exists. The browser always sends it, so no shop sees this today. A desk
with two counters, or any integration that omits it, would. **This is
the highest-value invisible defect in the codebase.**

**Test suites leave shared fixtures behind**, so file order is
load-bearing. Known instances: one suite adds `till-11` to the demo
branch and never removes it; another repoints the demo legal entity to a
GBP jurisdiction pack. Symptoms are `SCOPE_DENIED`, or assertions that
expected CAD getting GBP. If a test passes alone and fails in the suite,
this is why — do not chase it as a race.

**Assert deltas, not absolutes.** Tests that asserted a global total
(`outstanding.payable === "600.00"`, a volume figure) passed only while
they were the only file that ever posted. Assert what your test changed.

**A grep that finds nothing proves nothing.** The Rate Board was audited
as a static page that never reaches the server, scored 25%, and named as
the next priority — on the strength of searching one HTML file that
delegates all its work to two external scripts. It polls `/api/rates`
every 60s, pulls a provider catalogue, and publishes back. It was ~80%
all along. To answer "is this wired", drive it and watch the wire;
`tests/e2e/rate-board-seam.spec.ts` is what that looks like.

## 6. Where the seams are tested

Each of these drives a real screen against a real ledger. They are the
standard for anything touching money — a server test and a browser test
both passing while the join is broken is exactly how the defects above
survived green runs.

```
zz-a-day-at-the-desk    a full shift; the deployment gate
cash-seam               till sessions, floats, counts, close
obligation-seam         remittance send and receive
cheque-seam             cashing, clearing, the register
client-records-seam     customers, aliases, ID reveal audit
currency-set-seam       the desk's traded currencies
rate-board-seam         the board, the provider, publish
desk-thresholds-seam    reporting and identification lines
document-seam           generated paperwork from the ledger
reporting-seam          the Dashboard and Ledger headlines
till-switch-seam        which drawer a session writes to
```
