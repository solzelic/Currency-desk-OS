/* ============================================================
   A remittance, done in a real browser, then put to the ledger.

   Remittance was the largest of the five deal lines that moved drawer
   cash on screen and stopped there. The teller took six hundred dollars,
   an array in `os-src/cdos-transfers.jsx` grew by one, and
   `ledger_till_balances` never heard about it — so by the end of a day
   the till on the desk and the till on the server disagreed by whatever
   the shop had taken in, and no test anywhere noticed, because the
   server suite tested the ledger, the browser suite tested the screens,
   and nothing tested the join.

   So each test here does the deal the way a person does it and then asks
   BOTH sides what happened. The figure it compares is the one the screen
   itself put in front of the teller — "Collect $609.99", "Customer
   receives 405.11" — against what the ledger's drawer actually did. A
   test that posted through the API and then read the API back would
   prove nothing at all about the seam these defects live in.

   Against the code before this change every assertion below fails on the
   same line: the drawer does not move, because nothing was ever sent.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const OPENING = { CAD: "25000.00", USD: "12000.00" };

/** What the book says this desk owes and is owed, right now. */
function obligations(page: Page) {
  return page.evaluate(() =>
    fetch("/api/ledger/obligations?limit=50").then((r) => r.json()),
  ) as Promise<{
    obligations: Array<Record<string, string | null>>;
    outstanding: { payable: string | null; receivable: string | null };
  }>;
}

/* Put the drawer in a state a deal can be posted against, through the
   product's own endpoints. Both calls are ASSERTED rather than fired and
   forgotten — a helper that ignored a response hid a 500 in this repo
   for months, and a seam test whose setup silently failed would report a
   till that "did not move" for entirely the wrong reason. */
async function openDeskAndTill(page: Page) {
  await signInAtDesk(page);
  const book = ledger(page);
  const balances = await book.ensureOpeningBalances(OPENING);
  expect([201, 409]).toContain(balances.status);
  const opened = await page.evaluate(async () => {
    const r = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  expect([200, 201, 409]).toContain(opened.status);
  const session = await book.session();
  expect(session?.status).toBe("open");
  return book;
}

/* The new-transfer form, and ONLY it.

   Everything below is scoped to this. The Transfers app behind the modal
   is a pipeline of seeded deals whose rows carry the same beneficiary
   names the form offers, so an unscoped `getByRole("button", { name:
   /Maria Carter/ })` finds a row in the list underneath and then spends
   ninety seconds failing to click it through the form on top. */
function transferForm(page: Page) {
  return page
    .locator("div.fixed.inset-0")
    .filter({ has: page.getByRole("button", { name: /Create transfer/i }) });
}

async function openTransfers(page: Page) {
  await page.getByText(/^Transfers$/).first().click();
  const open = page.getByRole("button", { name: /New transfer/i }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();
  await expect(transferForm(page).getByPlaceholder(/Type a name…/)).toBeVisible();
}

/* Name the customer on the deal, and put the suggestion list away.

   The name box opens a list of the desk's roster the moment it has
   focus, and that list sits over the rest of the form — so a test that
   typed and went straight for the beneficiary spends thirty seconds
   clicking a menu that is not there. A person picks a suggestion, or
   clicks back onto the form when the roster has none. Clicking the
   direction the deal is already going is the harmless click nearest to
   hand, and it is inside the modal, which matters: the desk behind has
   its own copies of most of these words.

   Returns after the list is gone, so the caller can trust the next
   click. */
async function nameCustomer(page: Page, name: string, direction: RegExp) {
  const form = transferForm(page);
  await form.getByPlaceholder(/Type a name…/).fill(name);
  const suggestion = form.getByRole("button", { name, exact: true });
  if (await suggestion.count()) await suggestion.first().click();
  /* Tab out, which is what a person typing a name the desk has never
     seen does next. The list closes on blur — and until this change it
     could not close at all for a name with no match, which left the
     beneficiary picker underneath it unreachable. */
  else await form.getByPlaceholder(/Type a name…/).press("Tab");
  /* The list is gone before this returns. It is positioned over the rest
     of the form, so leaving it open makes every later click land on it. */
  console.log("ACTIVE >>>", await page.evaluate(() => (document.activeElement||{}).outerHTML?.slice(0,120)));
  await expect(form.getByText(/No match — type a new name/)).toHaveCount(0);
  await expect(form.getByRole("button", { name, exact: true })).toHaveCount(0);
}

/** Read a money figure out of the modal, the way the teller reads it. */
async function figure(page: Page, pattern: RegExp) {
  const body = await transferForm(page).innerText();
  const match = body.match(pattern);
  expect(match, `expected the screen to show ${pattern}`).not.toBeNull();
  return Number(match![1]!.replace(/,/g, ""));
}

test("a send takes the cash the screen said it would, and books the payout as owed", async ({ page }) => {
  const book = await openDeskAndTill(page);
  const before = Number((await book.till()).CAD);
  await openTransfers(page);

  /* Rachel Carter has a saved beneficiary in Cebu, which is what a
     remittance send needs before it can be created at all. */
  const form = transferForm(page);
  await nameCustomer(page, "Rachel Carter", /Send out/i);
  await form.locator("button").filter({ hasText: "Maria Carter" }).click();
  await form.getByPlaceholder("0.00").first().fill("600");
  await form.getByRole("combobox").filter({ hasText: /Family support|Select a purpose/ })
    .selectOption("Family support");

  /* What the screen is telling the teller to take. Everything below is
     measured against THIS number and not against a figure the test
     computed for itself. */
  const collect = await figure(page, /Collect \$?([\d,]+(?:\.\d{2})?)/);
  expect(collect).toBeCloseTo(609.99, 2);

  /* And what it is telling them the desk has earned. Not the spread
     against a market mid it used to claim — the desk has not bought the
     pesos yet and does not know what they will cost. */
  await expect(form.getByText(/rate margin at settlement/i)).toBeVisible();

  await form.getByRole("button", { name: /Create transfer/i }).click();
  /* The form closes when the ledger has accepted it and stays open, with
     a refusal on it, when the ledger has not. Waiting for it to go is
     therefore an assertion that the post succeeded — not merely a
     timing convenience. */
  await expect(form).toHaveCount(0, { timeout: 30_000 });

  /* THE SEAM. The drawer on the server moved by exactly the amount the
     screen asked the customer for. */
  const after = Number((await book.till()).CAD);
  expect(after - before).toBeCloseTo(collect, 2);

  const owed = await obligations(page);
  const payable = owed.obligations.find((o) => o.kind === "remittance_payable");
  expect(payable, "the payout the desk now owes should be on the book").toBeTruthy();
  expect(payable).toMatchObject({
    direction: "payable",
    status: "open",
    counterparty: "Cebuana Lhuillier",
    corridor: "PH",
    faceCurrency: "PHP",
    /* Carried at what the customer actually paid, not the payout
       translated at a mid — docs/OBLIGATION_LINES.md. */
    carryingAmountHome: "600.00",
    homeCurrency: "CAD",
  });
  expect(Number(payable!.faceAmount)).toBeGreaterThan(0);
  expect(owed.outstanding.payable).toBe("600.00");

  /* The deal is on the transaction list too, with the ledger's own
     reference — the browser row carries the book's name for it rather
     than a reference the browser invented for itself. */
  const posted = await page.evaluate(() =>
    fetch("/api/ledger/transactions?limit=20").then((r) => r.json()),
  );
  expect(
    posted.transactions.some(
      (t: { transactionId: string }) => t.transactionId === payable!.transactionId,
    ),
  ).toBe(true);
});

test("a receive pays out of the same drawer, against what the partner now owes", async ({ page }) => {
  const book = await openDeskAndTill(page);
  const before = Number((await book.till()).CAD);
  await openTransfers(page);

  const form = transferForm(page);
  await form.getByRole("button", { name: /Receive in/i }).click();
  await nameCustomer(page, "Rachel Carter", /Receive in/i);
  await form.getByPlaceholder("0.00").first().fill("16000");
  await form.getByRole("combobox").filter({ hasText: /Family support|Select a purpose/ })
    .selectOption("Family support");

  /* What the screen says the person at the counter walks away with. */
  const payout = await figure(page, /Customer receives \(CAD\)\s*CAD\s*([\d,]+(?:\.\d{2})?)/);
  expect(payout).toBeGreaterThan(0);

  await form.getByRole("button", { name: /Create transfer/i }).click();
  /* The form closes when the ledger has accepted it and stays open, with
     a refusal on it, when the ledger has not. Waiting for it to go is
     therefore an assertion that the post succeeded — not merely a
     timing convenience. */
  await expect(form).toHaveCount(0, { timeout: 30_000 });

  /* THE SEAM, the other way round: the drawer fell by exactly what the
     screen counted out, and not by the foreign sum somebody abroad
     dispatched — which is the figure the browser's own compliance
     aggregate was reading off these rows. */
  const after = Number((await book.till()).CAD);
  expect(before - after).toBeCloseTo(payout, 2);

  const owed = await obligations(page);
  const receivable = owed.obligations.find((o) => o.kind === "remittance_receivable");
  expect(receivable).toMatchObject({
    direction: "receivable",
    status: "open",
    counterparty: "Cebuana Lhuillier",
    faceCurrency: "PHP",
    faceAmount: "16000.00",
  });
  /* The desk fronted the payout AND kept its fee out of the funding, so
     what the partner owes it is both together. If the partner remits
     only the payout the desk did not break even — it lost its fee — and
     the carrying amount is what makes that visible at settlement. */
  expect(Number(receivable!.carryingAmountHome)).toBeCloseTo(payout + 9.99, 2);
});
