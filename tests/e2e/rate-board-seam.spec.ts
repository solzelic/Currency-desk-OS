/* ============================================================
   The board on the wall is the board on the server.

   This file exists because of an audit finding that was wrong, and the
   way it was wrong is worth writing down where the next person will see
   it.

   The Rate Board is rendered as an iframe over `YorkFX Rate Board.html`.
   A search for `api/rates` INSIDE that file returns nothing, and it was
   reported on that basis as a static demo page that never reaches the
   server. It isn't. The page loads `yorkfx-converter.js` and
   `yorkfx-staff.js`, and between them they read `/api/rates`, poll it
   every sixty seconds, pull the provider catalogue from
   `/api/rates/market`, and publish back to `/api/rates/publish`.

   A grep that finds nothing in one file proves nothing about a page that
   delegates to scripts — which is what HTML does. The only honest way to
   answer "is this wired" is to drive it and watch the wire, so that is
   what these tests do.

   What is asserted, in the order it matters:

     1. The board a desk sees is ITS OWN, resolved from the session, and
        the figures on screen are the figures the server sent.
     2. Publishing from the staff board reaches the ledger's own store,
        not just localStorage.
     3. `localStorage['yorkfx_rates_v1']` is a CACHE the server fills, not
        a second book — which was the other half of the wrong finding.
     4. The OS shell prices off the same board, so the deal screen and the
        wall agree.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/* The board as this file found it. Every test below publishes, and a
   published board is what the whole desk prices from — so the last test
   puts this back. Leaving a 0.5432 US dollar on the demo desk turned the
   Dashboard's earnings negative and failed reporting-seam.spec.ts, which
   is a fair description of what happens to a real shop when somebody
   fat-fingers the board and nothing puts it right. */
let asFound: Record<string, { mid: number; show: boolean }> | null = null;

/** What the server says this session's board is. */
const serverBoard = (page: Page) =>
  page.evaluate(() => fetch("/api/rates").then((r) => r.json()));

/** Put a board on the server for this desk, the way the staff page does. */
async function publish(page: Page, rows: Record<string, { mid: number; show: boolean }>) {
  return page.evaluate(
    (payload) =>
      fetch("/api/rates/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ buyMargin: 0.02, sellMargin: 0.02, rows: payload }),
      }).then((r) => r.status),
    rows,
  );
}

test("the desk's board comes from the server, and it is the desk's own", async ({
  page,
}) => {
  await signInAtDesk(page);

  const answer = await serverBoard(page);
  /* Kept, so the last test in this file can put it back. */
  asFound = answer.board?.rows ?? null;
  /* A board, and one that belongs to the branch this session is signed in
     at. `/api/rates` used to answer with a hardcoded demo branch whenever
     no branchId was given — and the OS has never sent one — so a second
     desk was shown York FX's prices on its own wall. */
  expect(answer.board, "this desk has no published board").toBeTruthy();
  expect(Object.keys(answer.board.rows).length).toBeGreaterThan(0);
  expect(typeof answer.serverTime).toBe("number");
});

test("publishing reaches the server, and the server hands it back", async ({ page }) => {
  /* `rates:change`, which a teller does not hold and a branch manager
     does. Signed in as one rather than granting the teller the
     permission: who may move the shop's prices is a real rule and this
     file has no business softening it. */
  await signInAtDesk(page, "r.haddad");

  const before = await serverBoard(page);
  const mid = 0.7777;
  expect(await publish(page, { USD: { mid, show: true } })).toBe(200);

  /* THE SEAM. Not "the screen changed" — the server was asked again, in a
     separate request, and it is carrying the new number. */
  await expect
    .poll(async () => (await serverBoard(page)).board?.rows?.USD?.mid, { timeout: 15_000 })
    .toBeCloseTo(mid, 4);

  /* And it is a NEW publication rather than an edit of the old one: the
     board is append-only by publication, which is what lets a posted deal
     name the exact board it was priced from. */
  const after = await serverBoard(page);
  expect(after.board.publishedAt).not.toBe(before.board?.publishedAt);
});

test("the browser's rate cache is filled BY the server, not instead of it", async ({
  page,
}) => {
  await signInAtDesk(page, "r.haddad");
  const mid = 0.6543;
  expect(await publish(page, { USD: { mid, show: true } })).toBe(200);

  /* `localStorage['yorkfx_rates_v1']` was read as evidence of a second
     book. It is the opposite: `applyBoard()` in yorkfx-converter.js
     WRITES the server's answer into it and fires a storage event so the
     shell repaints. Clearing it and re-fetching proves the direction —
     the server refills it. */
  await page.evaluate(() => localStorage.removeItem("yorkfx_rates_v1"));
  expect(await page.evaluate(() => localStorage.getItem("yorkfx_rates_v1"))).toBeNull();

  await page.reload();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem("yorkfx_rates_v1");
          if (!raw) return null;
          try {
            return JSON.parse(raw)?.rows?.USD?.mid ?? null;
          } catch {
            return null;
          }
        }),
      { timeout: 20_000 },
    )
    .toBeCloseTo(mid, 4);
});

test("the deal screen prices off the same board as the wall", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  const mid = 0.5432;
  expect(await publish(page, { USD: { mid, show: true } })).toBe(200);
  await page.reload();

  /* `crossRate()` prefers the live engine (`BY[]`), which
     yorkfx-converter.js fills from the server board, and only falls back
     to its compiled-in table when there is none. If these two ever
     disagree, the wall and the ticket are quoting different prices —
     which is the thing the wrong audit finding claimed was already
     happening.

     MIND THE DIRECTION, because it is the whole assertion. The board
     stores `mid` as HOME PER ONE UNIT — 0.5432 CAD buys one dollar — and
     `crossRate('CAD','USD')` answers the other way round, in units per
     home: 1/0.5432 = 1.8409. Getting this backwards is what made this
     test fail the first time, and the failing number was itself the
     proof, because the compiled-in fallback for USD is 0.7331 and
     nothing near 1.8409 exists anywhere but the board just published. */
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const rate = window.CDOS?.crossRate?.("CAD", "USD");
          return typeof rate === "number" ? rate : null;
        }),
      { timeout: 20_000 },
    )
    .toBeCloseTo(1 / mid, 3);

  const board = await serverBoard(page);
  expect(board.board.rows.USD.mid).toBeCloseTo(mid, 4);
});

test("the provider catalogue is served, and says who it came from", async ({ page }) => {
  await signInAtDesk(page);
  const market = await page.evaluate(() =>
    fetch("/api/rates/market").then((r) => r.json()),
  );

  /* Null is a legitimate answer — a desk that has never synced has no
     market snapshot, and inventing one would be a price nobody quoted.
     What must never happen is mids with no provider attached to them. */
  if (market.mids) {
    expect(market.provider, "mids with no provider named").toBeTruthy();
    expect(Object.keys(market.mids).length).toBeGreaterThan(0);
  } else {
    expect(market.provider).toBeNull();
  }
});

test("a teller may read the board and may not move it", async ({ page }) => {
  await signInAtDesk(page, "a.singh");

  /* Reading is everybody's — a teller quotes off this board all day. */
  expect((await serverBoard(page)).board).toBeTruthy();

  /* Changing what the shop charges is not. Asserted here because this
     file publishes as a manager throughout, and a test suite that only
     ever exercises the permitted path never notices the day the gate
     stops working. */
  expect(await publish(page, { USD: { mid: 0.99, show: true } })).toBe(403);
});

test("leaves the desk's board as it found it", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  expect(asFound, "the first test never captured a board to restore").toBeTruthy();

  /* Re-published rather than rolled back, because a board is append-only
     by publication — that is what lets a posted deal name the exact board
     it was priced from. Putting the old numbers back is a new publication
     saying so, which is also what a desk correcting a mistake does. */
  expect(await publish(page, asFound!)).toBe(200);
  await expect
    .poll(async () => (await serverBoard(page)).board?.rows?.USD?.mid, { timeout: 15_000 })
    .toBeCloseTo(asFound!.USD.mid, 4);
});
