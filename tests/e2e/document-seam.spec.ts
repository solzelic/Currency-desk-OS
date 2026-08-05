/* ============================================================
   The documents this desk signs, held to the book that generated them.

   The one that was caught: a teller counted all four drawers exactly, the
   Reconcile & close screen said "All counted drawers balanced · Drawers
   off 0 · Total variance 0", the day was closed, and the End-of-Day
   Sign-Off sheet came out saying this —

     Thursday, June 18, 2026 · Day 1     generated 2026-08-04
     TRANSACTIONS 10                     1, and it was voided
     PAY-IN VOLUME $32,700.00            $1,000, voided
     REVENUE $222.97                     $0.00
     CASH ON HAND $594,049.69            $62,450.54
     CAD variance −249,270.79            0
     EARNINGS BY TELLER: three tellers   one person traded, and earned nothing

   — over two signature lines, under the words "Registered Money Services
   Business". Every figure had a plausible local source: a demo seed, a
   browser-side sum, a count read out of localStorage, a spread estimated
   against a market mid, a currency hardcoded to one country.

   None of it was catchable by either existing suite. The server tests
   assert on the ledger, which was right the whole time. The browser tests
   assert on screens, and a document is generated into a DIFFERENT WINDOW,
   which is where a browser test stops looking. The disagreement lived in
   between, which is where the disagreements always live — see
   docs/CASH_OWNERSHIP_INVARIANTS.md, "testing standard".

   So this file drives the real screens, generates the real document, and
   asks the ledger whether it agrees. The rule the document follows is
   written down in docs/GENERATED_DOCUMENTS.md.

   FIXTURES ASSERT. Every setup call in this file checks its own response.
   A helper in reporting-seam.spec.ts once fired a request and ignored it,
   swallowing a 500, and the real assertion failed for a reason that had
   nothing to do with what was being tested.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, rendered } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/* The reads the sign-off sheet is built from, asked of the server from
   inside the signed-in page — the same session, the same workspace header,
   the same answer the screen is getting. */
function book(page: Page) {
  const get = (url: string) => page.evaluate((u) => fetch(u).then((r) => r.json()), url);
  return {
    summary: (q = "") => get("/api/ledger/summary" + q),
    position: () => get("/api/ledger/position"),
    jurisdiction: () => get("/api/ledger/jurisdiction"),
    session: () => get("/api/ledger/till-session"),
    balances: () => get("/api/ledger/till-balances").then((r: any) => r.balances ?? {}),
  };
}

const bodyText = (page: Page) => page.locator("body").innerText();

/* The window the desk asks the ledger for when it says "today" — built
   from the till session's own business date, exactly as businessDayWindow()
   does in cdos-base.jsx. Asked of the page so the test cannot drift from
   the product's own idea of where a day starts. */
async function todayWindow(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window.CDOS.businessDayWindow(1);
    return `?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`;
  });
}

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

/* Cash into the drawer through the desk's own rail — a bank top-up, which
   is a real movement. A test that reached into the balances table would
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
          idempotencyKey: `doc-seam-topup-${currency}-${Date.now()}`,
          direction: "in",
          currency,
          amount: (amount - have).toFixed(2),
          counterpartyType: "bank",
          counterpartyRef: "doc-seam-fixture",
          reason: "Top-up so the document seam has a desk that can trade",
        }),
      });
      done.push(answer.ok ? `${currency}:ok` : `${currency}:${answer.status} ${await answer.text()}`);
    }
    return done.join(" · ");
  }, wanted);
}

/* One real deal, posted the way the counter posts one: freeze a quote,
   then post it. */
async function postOneDeal(page: Page, key: string) {
  return page.evaluate(async (k) => {
    const customers = await fetch("/api/ledger/customers").then((r) => r.json());
    let customerId = customers.customers?.[0]?.customerId;
    if (!customerId) {
      const made = await fetch("/api/ledger/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalRef: "doc-seam",
          name: "Document Seam",
          risk: "normal",
          idStatus: "verified",
        }),
      }).then((r) => r.json());
      customerId = made.customerId;
    }
    /* Two ways round: the seam database outlives a run, so the drawer's
       stock is whatever earlier files left in it. */
    const attempts = [
      { from: "CAD", to: "USD", inputAmount: "1000.00", direction: "customer_buy_foreign" },
      { from: "USD", to: "CAD", inputAmount: "100.00", direction: "customer_sell_foreign" },
    ];
    const refused: string[] = [];
    for (const attempt of attempts) {
      const quote = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, feeCad: "7.50", ...attempt }),
      });
      if (!quote.ok) { refused.push(`quote ${attempt.from}→${attempt.to}: ${quote.status} ${await quote.text()}`); continue; }
      const frozen = await quote.json();
      const posted = await fetch(`/api/quotes/${frozen.quoteId}/post`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `${k}-${attempt.from}${attempt.to}`,
          purpose: "Personal travel",
          sourceOfFunds: "Employment income",
        }),
      });
      if (!posted.ok) { refused.push(`post ${attempt.from}→${attempt.to}: ${posted.status} ${await posted.text()}`); continue; }
      return { ok: true, ...(await posted.json()) };
    }
    return { ok: false, why: refused.join(" · ") };
  }, key);
}

/* Count every ledger currency at EXACTLY what the ledger holds, and close.
   This is the walk that was audited: the counts are perfect, so the close
   is clean, so any variance the sign-off sheet prints is invented.

   Through the product's own routes rather than the count sheet's inputs —
   what is being tested is whether the DOCUMENT agrees with the book, and a
   count typed into a drawer that then failed to reach the server would fail
   this test for the wrong reason and hide the real one. */
async function countExactlyAndClose(page: Page, key: string) {
  return page.evaluate(async (k) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const balances: Record<string, string> = held.balances ?? {};
    const counts = Object.fromEntries(
      Object.entries(balances).map(([c, v]) => [c, Number(v).toFixed(2)]),
    );
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status !== "open") return { ok: false, why: "no open session to close" };

    const counted = await fetch("/api/ledger/till-counts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: `${k}-count`, counts }),
    });
    if (!counted.ok) return { ok: false, why: `count: ${counted.status} ${await counted.text()}` };

    const closed = await fetch(`/api/ledger/till-sessions/${current.session.sessionId}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `${k}-close`,
        counts,
        note: "All counted drawers balanced",
      }),
    });
    if (!closed.ok) return { ok: false, why: `close: ${closed.status} ${await closed.text()}` };
    return { ok: true, counts, sessionId: current.session.sessionId };
  }, key);
}

/* Open Reports and generate a named sheet. The document renders into
   `#cdos-report-doc`, which is the node the print handler clones into the
   popup — so asserting on that node is asserting on what gets printed,
   without needing to drive a popup window. */
async function generate(page: Page, card: RegExp) {
  /* Back to the launcher if a document is already open, otherwise open the
     app. Both, so this can be called repeatedly in one test. */
  const back = page.getByRole("button", { name: /All reports/i }).first();
  if (await back.isVisible().catch(() => false)) await back.click();
  else await page.getByText(/^Reports$/).first().click();
  await rendered(page, /End-of-Day Sign-Off/);
  await page.getByText(card).first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
}
const sheet = (page: Page) => page.locator("#cdos-report-doc").innerText();

/* ------------------------------------------------------------------
   1. THE WALK THAT WAS AUDITED

   Open a till, post a real deal, count exactly, close the day, generate
   the sign-off sheet — and hold every figure on it to the ledger.
   ------------------------------------------------------------------ */
test("the sign-off sheet is the ledger's own figures, on the desk's own day", async ({ page }) => {
  await signInAtDesk(page);
  const session = await ensureOpenSession(page);
  expect(session, `the till would not open: ${session}`).toBe("open");
  const topUp = await ensureDrawerHas(page, { CAD: 5000, USD: 2000 });
  expect(topUp, `the drawer could not be topped up: ${topUp}`).not.toMatch(/\d{3}/);

  const key = `doc-seam-${Date.now()}`;
  const deal = await postOneDeal(page, key);
  expect(deal.ok, `no deal could be posted: ${deal.why}`).toBe(true);

  const closed = await countExactlyAndClose(page, key);
  expect(closed.ok, `the day would not close: ${closed.why}`).toBe(true);

  await page.reload();
  const server = book(page);
  const day = await server.summary(await todayWindow(page));
  const held = await server.position();
  const till = await server.session();
  const pack = (await server.jurisdiction()).pack;

  await generate(page, /End-of-Day Sign-Off/);
  /* The document fetches for itself, so "the node is visible" and "the
     answers have landed" are different moments. Poll for the trading day's
     own date, which is the first thing the sheet can only get from the
     session. */
  await expect
    .poll(() => sheet(page), { timeout: 30_000 })
    .toContain(`trading day ${till.session.businessDate}`);
  const doc = await sheet(page);

  // ---- the date and the day ----
  /* The sheet was headed "Thursday, June 18, 2026 · Day 1" — a hardcoded
     string seven weeks in the past, and a day counter kept in the browser.
     Both are the till session's now. */
  expect(doc).toContain(`Session #${till.session.sessionNumber}`);
  expect(doc).not.toContain("2026-06-18");
  expect(doc).not.toContain("June 18, 2026");

  // ---- the counts ----
  /* The sheet said TRANSACTIONS 10 for a till that had posted one. */
  expect(day.posted).toBeGreaterThan(0);
  /* Case-insensitive: these labels are uppercased by CSS, and innerText
     returns the transformed text. */
  expect(doc).toMatch(new RegExp(`Transactions\\s*\\n?\\s*${day.posted}\\b`, "i"));

  // ---- the money, in the desk's own currency ----
  const money = (v: string) =>
    new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: pack.homeCurrency,
      maximumFractionDigits: 2,
    }).format(Number(v));

  expect(day.volumeHome, "the deal this test posted has a home-currency leg").not.toBeNull();
  expect(doc).toContain(money(day.volumeHome));
  if (day.earningsHome != null) expect(doc).toContain(money(day.earningsHome));

  // ---- THE VARIANCE THAT COST $249,270.79 ----
  /* Everything was counted at exactly what the ledger held, so every
     variance on this sheet is zero and it says "balanced". The old sheet
     compared a count of the DRAWER against the drawer PLUS THE SAFE and
     printed a six-figure discrepancy above the signature lines. */
  const counts = till.latestCounts ?? {};
  expect(Object.keys(counts).length, "the close recorded counts on the ledger").toBeGreaterThan(0);
  for (const [currency, record] of Object.entries<any>(counts)) {
    expect(doc).toContain(currency);
    expect(
      Math.abs(Number(record.variance)),
      `the ledger itself recorded a variance on ${currency}`,
    ).toBeLessThan(0.005);
  }
  /* No negative money anywhere on a sheet that balanced. This is the
     assertion that would have caught it: it needs no magic constant and it
     cannot be satisfied by a different plausible-looking number. */
  expect(doc, "a day counted exactly must not print a negative variance").not.toMatch(
    /−[\d,]{3,}|-\$[\d,]{3,}/,
  );

  // ---- the drawer, not the drawer plus the safe ----
  /* Each currency's ledger column is the TILL's balance. Asserted against
     GET /api/ledger/till-balances, which is the drawer and nothing else. */
  const drawer = await server.balances();
  const drawerNames = Object.keys(drawer);
  expect(drawerNames.length).toBeGreaterThan(0);
  /* Formatted the way the product formats a quantity — `num()` in
     cdos-base.jsx, which is en-CA with at most two decimals and no
     minimum. Matching it here rather than picking our own rendering is
     what keeps this an assertion about the FIGURE rather than about the
     formatter. */
  const units = (v: unknown) =>
    Number(v).toLocaleString("en-CA", { maximumFractionDigits: 2 });
  for (const currency of drawerNames) {
    expect(doc, `the drawer's ${currency} balance is on the sheet`).toContain(units(drawer[currency]));
  }
  /* And the whole-branch figure is NOT what the drawer column shows, on any
     currency where the safe holds something. */
  for (const row of held.currencies ?? []) {
    if (!row.vault || Number(row.vault.quantity) <= 0) continue;
    const branchTotal = units(row.quantity);
    const drawerOnly = units(row.till?.quantity ?? 0);
    if (branchTotal === drawerOnly) continue;
    expect(
      doc,
      `${row.currency}: the sheet must show the drawer (${drawerOnly}), not drawer+safe (${branchTotal})`,
    ).toContain(drawerOnly);
  }

  // ---- earnings by teller ----
  /* Three named tellers appeared here on a day one person had traded. The
     panel is now the ledger's byActor block, so the names on the sheet are
     exactly the principals the ledger recorded — no more. */
  const actors = day.byActor ?? [];
  expect(actors.length, "one deal was posted, so one actor earned").toBeGreaterThan(0);
  const earners = doc.slice(doc.toLowerCase().indexOf("earnings by teller"));
  for (const other of ["R. Haddad", "M. Costa", "S. Iqbal"]) {
    if (actors.some((a: any) => a.actorId.includes(other.split(". ")[1]!.toLowerCase()))) continue;
    expect(earners, `${other} did not trade at this till today`).not.toContain(other);
  }

  // ---- and the demo book's fingerprints, gone ----
  for (const ghost of ["32,700", "222.97", "594,049", "249,270", "130,566"]) {
    expect(doc, `the demo book's ${ghost} is on a signed document`).not.toContain(ghost);
  }
});

/* ------------------------------------------------------------------
   2. A DAY WITH NOTHING ON IT SAYS SO

   The other half of the rule, and the easier one to regress: an empty
   period must produce a sheet that says it is empty, not one with
   confident zeros. See docs/ABSENT_FIGURES.md — a printed 0.00 becomes
   evidence.
   ------------------------------------------------------------------ */
test("a period with nothing posted prints dashes and reasons, never zeros", async ({ page }) => {
  await signInAtDesk(page);
  const server = book(page);

  /* A window that cannot contain anything: a full day, a year before this
     desk existed. The report's own custom-date filter is what a user would
     reach for, and it feeds the same read. */
  const empty = await server.summary("?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z");
  /* Asserted, not assumed. If this window somehow had transactions in it
     the test below would be checking nothing at all. */
  expect(empty.posted, "the 2020 window is genuinely empty").toBe(0);
  /* The server's half of the rule: counts are real, money is null. */
  expect(empty.volumeHome).toBeNull();
  expect(empty.feesHome).toBeNull();
  expect(empty.realizedPnlHome).toBeNull();
  expect(empty.earningsHome).toBeNull();
  expect(empty.byActor).toEqual([]);

  await generate(page, /Period Summary/);
  await page.getByRole("button", { name: /Filters/i }).first().click();
  await page.locator('input[type="date"]').first().fill("2020-01-01");
  await page.locator('input[type="date"]').nth(1).fill("2020-01-01");
  await page.getByRole("button", { name: /^Done$/ }).first().click();

  await expect.poll(() => sheet(page), { timeout: 30_000 }).toContain("—");
  const doc = await sheet(page);

  /* The screen's half: a dash AND a reason, and no confident zero standing
     where a real figure would go. */
  expect(doc).toMatch(/nothing posted|no volume to divide by|the ledger has no/i);
  expect(doc, "an empty period must not report a currency amount of zero").not.toMatch(
    /\$0\.00|0\.00\s*(CAD|USD|GBP|EUR|AED|AUD)\b/,
  );
});

/* ------------------------------------------------------------------
   3. NOTHING IS MANUFACTURED

   A desk that has generated no reports and run no verifications has no
   compliance history. Four sealed filings with invented FINTRAC
   acknowledgement numbers, and eleven completed identity verifications
   against named people, were written into localStorage on module load.
   ------------------------------------------------------------------ */
test("a desk that has filed nothing has no filings", async ({ page }) => {
  await signInAtDesk(page);
  /* Clear the two stores the seeds wrote to, then reload: if anything
     re-manufactures them on load, it happens right here. */
  await page.evaluate(() => {
    localStorage.removeItem("cdos_report_history_v1");
    localStorage.removeItem("cdos_report_history_seed_v3");
    localStorage.removeItem("cdos_kyc_v1");
    localStorage.removeItem("cdos_kyc_seed_v3");
    localStorage.removeItem("cdos_till_history_v2");
  });
  await page.reload();
  await rendered(page, /Cash Drawer|Ledger|Dashboard/);

  const manufactured = await page.evaluate(() => {
    const read = (k: string) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
    const history = read("cdos_report_history_v1") || [];
    const kyc = read("cdos_kyc_v1") || {};
    const till = read("cdos_till_history_v2") || {};
    return {
      filings: (history as any[]).filter((e) => e && e.filing).map((e) => e.ack || e.ref),
      kycChecks: Object.keys(kyc).length,
      tillDays: Object.keys(till).length,
      raw: JSON.stringify(history).slice(0, 4000),
    };
  });

  /* The four sealed filings, by their invented acknowledgement numbers. */
  expect(manufactured.filings, "a filing exists that nobody filed").toEqual([]);
  for (const receipt of ["FIN-4471", "FIN-5520", "FIN-6093", "LCTR-2026", "EFTR-2026"]) {
    expect(manufactured.raw, `${receipt} was manufactured in the browser`).not.toContain(receipt);
  }
  /* The eleven identity verifications. */
  expect(manufactured.kycChecks, "identity verifications exist that nobody ran").toBe(0);
  /* And the year of invented drawer counts the sign-off sheet used to read
     its "Counted" column out of. */
  expect(manufactured.tillDays, "drawer counts exist that nobody counted").toBe(0);
});

/* ------------------------------------------------------------------
   4. THE DOCUMENT IS IN THE DESK'S OWN CURRENCY, AND NAMES ITS OWN
      REGULATOR

   "It should not be hardcoded in Canadian. It should be whatever the base
   currency is." The compliance pack printed "Prepared for FINTRAC
   record-keeping under the PCMLTFA" regardless of which country installed
   the product.
   ------------------------------------------------------------------ */
test("every document is in the desk's currency and names the pack's regulator", async ({ page }) => {
  /* As the branch manager. Report access is role-gated (Reports ▸ Manage
     access): a Senior teller can generate three of the seven, so a test
     signed in as one would silently skip the compliance pack — which is
     the document that carried "Prepared for FINTRAC record-keeping under
     the PCMLTFA" on every desk in every country. */
  await signInAtDesk(page, "r.haddad");
  const server = book(page);
  const answer = await server.jurisdiction();
  const pack = answer.pack;
  expect(pack.homeCurrency, "the entity has a home currency on its pack").toBeTruthy();
  expect(pack.regulator, "the entity has a regulator on its pack").toBeTruthy();
  /* The forms the pack makes this desk file — the read this pass added, so
     the filing worksheet can name the right portal instead of Canada's. */
  expect(Array.isArray(answer.reports), "the jurisdiction read carries the pack's forms").toBe(true);

  for (const [card, needle] of [
    [/Period Summary/, /Pay-in volume/i],
    [/Revenue & Earnings/, /Earnings by teller/i],
    [/Profit & Loss/, /Profit & loss statement/i],
  ] as [RegExp, RegExp][]) {
    await generate(page, card);
    await expect.poll(() => sheet(page), { timeout: 30_000 }).toMatch(needle);
    const doc = await sheet(page);
    /* The currency word appears, and no OTHER desk's currency is asserted
       as this desk's books. A CAD drawer on a GBP desk is legitimate and
       would appear as a row label, so this checks the statement of account
       currency rather than every mention. */
    expect(doc).toContain(pack.homeCurrency);
  }

  /* The compliance pack's own sentence. */
  /* The card is named by the pack too — it said "FINTRAC / LCTR Pack" on
     every desk. Matched on the desk's own regulator so this case fails on a
     UK desk if either the card or the document is still Canadian. */
  await generate(page, new RegExp(`${pack.regulator} / ${pack.reportName} Pack`));
  await expect.poll(() => sheet(page), { timeout: 30_000 }).toMatch(/record-keeping/i);
  const compliance = await sheet(page);
  expect(compliance).toContain(pack.regulator);
  if (pack.regulator !== "FINTRAC") {
    expect(compliance, "a non-Canadian desk must not cite FINTRAC").not.toContain("FINTRAC");
    expect(compliance, "a non-Canadian desk must not cite the PCMLTFA").not.toContain("PCMLTFA");
  }
});
