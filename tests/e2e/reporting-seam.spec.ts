/* ============================================================
   Where the summary screens meet the book.

   The cash-movement paths reached the ledger a while ago. The screens
   that REPORT on them did not, and that turned out to be the more
   expensive half. An exploratory run against a desk with one $1,000 deal
   on it found:

     Ledger header      38 records · $130,566.36 pay-in · $1,051.86 fees
     Dashboard          Earnings $1,150 · Volume $130,566 · Deals 38
     Dashboard exposure EUR SHORT −$10,302 · PHP SHORT −$13,900
     Vault position     $594,124.00 on hand · Unrealized P&L +$4,461.13
     Close-out          Earned today $223.00 · Transactions 10

   Every one of those came out of a demo seed compiled into the browser,
   and every one of them survived a fully green test run — the server
   suite tested the ledger, the browser suite tested the screens, and
   nothing tested the join. The exposure panel is the one that costs
   money: an owner hedging off it would sell euros the desk was LONG and
   buy pesos it had never held.

   So these tests read BOTH sides. They ask the ledger what it holds and
   what it earned, then read the same figures off the rendered screen and
   assert they are the same number — and, just as importantly, that where
   the ledger has no answer the screen shows an absent one rather than a
   confident zero. See docs/ABSENT_FIGURES.md.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, ledger, rendered } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/* The reads this whole file is about, asked of the server from inside the
   signed-in page — the same session, the same workspace header, the same
   answer the screen is getting. */
function book(page: Page) {
  const get = (url: string) => page.evaluate((u) => fetch(u).then((r) => r.json()), url);
  return {
    summary: () => get("/api/ledger/summary"),
    position: () => get("/api/ledger/position"),
    jurisdiction: () => get("/api/ledger/jurisdiction"),
    transactions: () => get("/api/ledger/transactions?limit=200"),
  };
}

async function openApp(page: Page, title: string | RegExp) {
  await page.getByText(title).first().click();
}

const bodyText = (page: Page) => page.locator("body").innerText();

/* Post one real deal the way the counter does: freeze a quote, then post
   it. The write path has its own seam tests (cash-seam.spec.ts); what
   this file needs is a transaction that genuinely exists in the book so
   the reporting screens can be held to it. */
async function postOneDeal(page: Page, idempotencyKey: string) {
  return page.evaluate(async (key) => {
    const customers = await fetch("/api/ledger/customers").then((r) => r.json());
    let customerId = customers.customers?.[0]?.customerId;
    if (!customerId) {
      const made = await fetch("/api/ledger/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalRef: "seam-reporting",
          name: "Reporting Seam",
          risk: "normal",
          idStatus: "verified",
        }),
      }).then((r) => r.json());
      customerId = made.customerId;
    }
    /* Two ways round, because the seam database outlives a run and the
       drawer's stock is whatever earlier tests left in it. Selling the
       customer dollars needs dollars in the till; buying dollars from them
       needs home currency. One of those is always true of a working desk,
       and the test is about the reporting screens either way. */
    const attempts = [
      { from: "CAD", to: "USD", inputAmount: "1000.00", direction: "customer_buy_foreign" },
      { from: "USD", to: "CAD", inputAmount: "100.00", direction: "customer_sell_foreign" },
    ];
    const refused = [];
    for (const attempt of attempts) {
      const quote = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, feeCad: "5.00", ...attempt }),
      });
      if (!quote.ok) { refused.push(`quote ${attempt.from}→${attempt.to}: ${quote.status} ${await quote.text()}`); continue; }
      const frozen = await quote.json();
      const posted = await fetch(`/api/quotes/${frozen.quoteId}/post`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `${key}-${attempt.from}${attempt.to}`,
          purpose: "Personal travel",
          sourceOfFunds: "Employment income",
        }),
      });
      if (!posted.ok) { refused.push(`post ${attempt.from}→${attempt.to}: ${posted.status} ${await posted.text()}`); continue; }
      return { ok: true, ...(await posted.json()) };
    }
    return { ok: false, why: refused.join(" · ") };
  }, idempotencyKey);
}

/* A till has to be open before anything can be posted against it, and the
   seam database outlives a run — cash-seam closes the session it opened,
   so this file cannot assume one. Opening through the product's own route
   rather than with fixture SQL: setup that lies about how the product
   works stops catching the product breaking. */
async function ensureOpenSession(page: Page) {
  const status = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return opened.ok ? "open" : `${opened.status} ${await opened.text()}`;
  });
  await page.reload();
  return status;
}

/* Put enough cash in the drawer to trade, through the desk's own cash
   rail — a bank top-up, which is a real movement and does not need the
   vault. The seam database outlives a run and cash-seam closes the till by
   counting it, so a later file can find an empty drawer and refuse every
   quote for INSUFFICIENT_TILL_LIQUIDITY. Topping up through the product
   keeps this honest: a test that reached into the balances table would
   stop catching a broken rail. */
async function ensureDrawerHas(page: Page, wanted: Record<string, number>) {
  return page.evaluate(async (want) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const done: string[] = [];
    for (const [currency, amount] of Object.entries(want)) {
      const have = Number(held.balances?.[currency] ?? 0);
      if (have >= amount) continue;
      const answer = await fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `seam-topup-${currency}-${Date.now()}`,
          direction: "in",
          currency,
          amount: (amount - have).toFixed(2),
          counterpartyType: "bank",
          counterpartyRef: "seam-fixture",
          reason: "Top-up so the reporting seam has a desk that can trade",
        }),
      });
      done.push(
        answer.ok
          ? `${currency}:ok`
          : `${currency}:${answer.status} ${await answer.text()}`,
      );
    }
    return done.join(" · ");
  }, wanted);
}

async function reverse(page: Page, transactionId: string, key: string) {
  return page.evaluate(
    async ([id, k]) =>
      fetch(`/api/ledger/transactions/${id}/reversal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: k, reason: "Seam test" }),
      }).then((r) => r.status),
    [transactionId, key],
  );
}

/* ------------------------------------------------------------------
   1. NO DEMO BOOK, ANYWHERE
   ------------------------------------------------------------------ */
test("the desk opens on its own book, not on York FX's thirty-eight deals", async ({ page }) => {
  await signInAtDesk(page);
  const server = book(page);
  const posted = (await server.transactions()).transactions ?? [];

  await openApp(page, /^Ledger$/);
  await rendered(page, /Pay-in volume/i);
  const ledgerScreen = await bodyText(page);

  /* The header used to read "38 records" for a desk with one. It is now
     whatever the ledger actually holds, and the assertion is that number
     rather than a magic constant — this test has to keep working on a
     database other tests have posted into. */
  const live = posted.filter((t: { reversal: unknown }) => !t.reversal);
  expect(ledgerScreen).toContain(String(live.length));

  /* The seed's own fingerprints. Any of these on screen means the demo
     book is back: its volume, its date, and two of its customers. */
  for (const fingerprint of ["130,566", "1,051.86", "2026-06-18", "Northbridge Imports", "Golden Crescent Travel"]) {
    expect(ledgerScreen).not.toContain(fingerprint);
  }
});

/* ------------------------------------------------------------------
   2. THE PANEL THAT LOSES MONEY
   ------------------------------------------------------------------ */
test("the Dashboard reports what the desk holds, not the net of its deals", async ({ page }) => {
  await signInAtDesk(page);
  const server = book(page);
  const held = await server.position();

  /* What the panel MUST end up printing, worked out from the book before
     the screen is looked at. The panel rounds to whole units of the home
     currency, so these are the rounded figures — the point is that they
     are the LEDGER's, and not some other number that also looks like
     money. */
  const onLedger = (held.currencies ?? []).filter(
    (c: { quantity: string }) => Number(c.quantity) > 0,
  );
  const mustPrint = onLedger
    .filter((c: { marketValueHome: string | null }) => c.marketValueHome != null)
    .map((c: { marketValueHome: string }) =>
      Math.round(Number(c.marketValueHome)).toLocaleString("en-CA"),
    )
    .filter((v: string) => v !== "0");

  await openApp(page, /^Dashboard$/);
  await rendered(page, /Cash position/i);
  /* The panel asks the ledger for itself, so "the card has painted" and
     "the answer has landed" are two different moments — and an assertion
     read between them passes on an empty panel, which is exactly the kind
     of green this file exists to stop trusting. So the wait is for one of
     the figures themselves, or for the panel saying plainly that there
     are none. */
  await expect
    .poll(() => bodyText(page), { timeout: 25_000 })
    .toMatch(
      mustPrint.length
        ? new RegExp(mustPrint.map((v: string) => v.replace(/,/g, ",")).join("|"))
        : /no till or vault balance|The ledger has this desk/,
    );
  const screen = await bodyText(page);

  /* Physical cash is never short. The old panel derived a "position" from
     pay-ins minus pay-outs and printed SHORT beside currencies the desk
     was long — the single most dangerous line in the product. */
  expect(screen).not.toMatch(/\bSHORT\b/);

  // every currency the ledger says is in a box is on the panel, at its figure
  for (const row of onLedger) expect(screen).toContain(row.currency);
  for (const want of mustPrint) expect(screen).toContain(want);

  // and the seed's invented exposure figures are gone with it
  for (const fingerprint of ["10,302", "13,900", "594,124"]) {
    expect(screen).not.toContain(fingerprint);
  }
});

/* ------------------------------------------------------------------
   3. ABSENT, NOT ZERO
   ------------------------------------------------------------------ */
test("a figure the ledger cannot answer is shown as absent", async ({ page }) => {
  await signInAtDesk(page);
  const server = book(page);
  const held = await server.position();

  await openApp(page, /Cash on Hand · Vault/i);
  await rendered(page, /Position/i);
  const screen = await bodyText(page);

  if (!held.vaultTracked) {
    /* A vault nobody has declared is not an empty vault. The banner was
       always right; the nine bold unqualified figures underneath it were
       the bug. */
    await expect(page.getByText(/isn.t on the ledger yet/i).first()).toBeVisible();
    expect(screen).toContain("—");
    expect(screen).not.toContain("594,124");
    return;
  }

  const totals = held.vaultTotals;
  if (totals.marketValueHome == null) {
    expect(screen).toContain("—");
  } else {
    expect(screen).toContain(
      Math.round(Number(totals.marketValueHome)).toLocaleString("en-CA"),
    );
  }

  /* The tile that was pure fiction. Where the ledger has no basis for
     every currency in the safe, there is no unrealized P&L to print, and
     the screen must say so instead of inventing one. */
  if (totals.unrealizedPnlHome == null) {
    const tile = page.getByText(/Unrealized P&L/i).first();
    await expect(tile).toBeVisible();
    expect(screen).toMatch(/no cost basis|market value or basis unknown/i);
  }
});

/* ------------------------------------------------------------------
   4. THE WALK THE OWNER ASKED FOR
   ------------------------------------------------------------------ */
test("posting one deal moves every headline, and voiding it moves them back", async ({ page }) => {
  await signInAtDesk(page);
  /* Asserted, like the top-up below. Two fixtures in this file used to
     fire and forget, and between them they cost an afternoon: the real
     assertion failed for a reason that had nothing to do with what was
     being tested. */
  const session = await ensureOpenSession(page);
  expect(session, `the till would not open: ${session}`).toBe("open");
  /* Asserted, not fired and forgotten. A fixture that fails quietly leaves
     the real assertion below failing for a reason that has nothing to do
     with what is being tested — which is how a whole afternoon goes. */
  const topUp = await ensureDrawerHas(page, { CAD: 5000, USD: 2000 });
  expect(topUp, `the drawer could not be topped up: ${topUp}`).not.toMatch(/\d{3}/);
  const server = book(page);

  const before = await server.summary();
  const key = `reporting-seam-${Date.now()}`;
  const deal = await postOneDeal(page, key);
  /* Asserted rather than skipped. A skip here would let this file report
     green on a desk that cannot post at all, which is the shape of green
     the whole project is trying to stop believing. */
  expect(deal.ok, `no deal could be posted: ${deal.why}`).toBe(true);

  const after = await server.summary();
  expect(after.posted).toBe(before.posted + 1);
  expect(Number(after.volumeHome)).toBeGreaterThan(Number(before.volumeHome ?? 0));

  /* THE ASSERTION THIS FILE EXISTS FOR: the screen's number is the book's
     number, checked after a real change rather than at rest.

     Reloaded first, because this deal was posted through the API rather
     than through the counter — the screen has had no reason to hear about
     it, and a teller coming back to the desk gets a fresh page too. What
     is being tested is what the Ledger renders from the book, not the
     in-window refresh, which the posting path already does for itself. */
  await page.reload();
  await openApp(page, /^Ledger$/);
  await rendered(page, /Pay-in volume/i);
  /* Polled on the VOLUME rather than the count: the count is a single
     digit that matches somewhere on any screen, so a test polling for it
     goes green the instant the window paints and reads the header before
     the ledger fetch has landed. That is the shape of assertion this whole
     file exists to stop trusting. */
  const wantVolume = Math.round(Number(after.volumeHome)).toLocaleString("en-CA");
  await expect.poll(() => bodyText(page), { timeout: 25_000 }).toContain(wantVolume);
  expect(await bodyText(page)).toContain(`${after.posted} record`);

  await openApp(page, /^Dashboard$/);
  await rendered(page, /Cash position/i);
  if (after.earningsHome != null) {
    /* The masthead's headline: commission plus the realized margin the
       disposal booked. Polled on the figure itself, for the same reason
       as above. */
    const earned = Math.round(Number(after.earningsHome)).toLocaleString("en-CA");
    await expect.poll(() => bodyText(page), { timeout: 25_000 }).toContain(earned);
  }
  const dash = await bodyText(page);
  expect(dash).toContain(String(after.posted));

  // ---- and back again ----
  expect(await reverse(page, deal.transactionId, `${key}-rev`)).toBe(201);
  const undone = await server.summary();
  expect(undone.posted).toBe(before.posted);
  expect(undone.reversed).toBe(before.reversed + 1);

  await page.reload();
  await openApp(page, /^Ledger$/);
  await rendered(page, /Pay-in volume/i);
  await expect
    .poll(() => bodyText(page), { timeout: 25_000 })
    .toContain(`${before.posted} record`);
  /* And the deal's volume is off the header again — a void is a deal that
     did not happen, not one that earned nothing. */
  if (before.volumeHome == null) {
    expect(await bodyText(page)).not.toContain(wantVolume);
  }
});

/* ------------------------------------------------------------------
   5. ONE LINE, ONE DATE
   ------------------------------------------------------------------ */
test("the reporting threshold and the date on the ticket are the desk's own", async ({ page }) => {
  await signInAtDesk(page);
  await ensureOpenSession(page);
  const server = book(page);
  const pack = (await server.jurisdiction()).pack;
  const session = await ledger(page).session();

  await openApp(page, /^Ledger$/);
  await rendered(page, /Pay-in volume/i);
  const screen = await bodyText(page);

  /* The Ledger flagged rows against a hardcoded 10,000 Canadian dollars
     while Compliance flagged against the owner's setting — the same desk,
     two different lines. The stat card now prints the pack's figure. */
  const line = Number(pack.reportThreshold);
  expect(screen).toMatch(
    new RegExp(`Reportable ≥[^\\n]*${line.toLocaleString("en-CA").replace(/,/g, ",")}`),
  );

  /* And the desk's idea of "today" is the ledger's. `TODAY` was a string
     literal seven weeks in the past: the New Transaction ticket was headed
     with it, cash-rail movement references were minted from it, and the
     drawer's history labelled that row TODAY under a banner showing the
     real date. Asked of the page itself, because these two values are the
     seam — one is the browser's, one is the till session's. */
  const dates = await page.evaluate(() => ({
    today: window.CDOS.TODAY,
    business: window.CDOS.businessDate(),
  }));
  expect(dates.today).not.toBe("2026-06-18");
  expect(dates.business).toBe(session?.businessDate ?? dates.today);

  /* And the ticket the teller reads carries it. This is the line that was
     read back to customers: "Exchange · A. Singh · 2026-06-18", under a
     session banner showing the real date. */
  const newDeal = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(newDeal).toBeEnabled({ timeout: 30_000 });
  await newDeal.click();
  await expect
    .poll(() => bodyText(page), { timeout: 20_000 })
    .toMatch(new RegExp(`·\\s*${dates.today}`));
  expect(await bodyText(page)).not.toContain("2026-06-18");
});
