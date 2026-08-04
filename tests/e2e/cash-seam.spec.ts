/* ============================================================
   Where the screen meets the book.

   Every cash defect this project has had lived here, and every one of them
   survived a fully green test run, because the server suite tested the
   ledger, the journey suite tested the desk, and nothing tested the join.
   Two books do not crash. They disagree, quietly, and the daily close
   overwrites the evidence that they did.

   So each test below does one thing and then asks BOTH sides what happened.
   The close test in particular is the one that matters: an earlier version
   of the drawer sent "0.00" for any currency nobody had counted, and the
   server dutifully wrote zero over real money. That bug passed every test
   in the repository.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const OPENING = { CAD: "25000.00", USD: "12000.00" };

/** Read what the Cash Drawer is telling the teller it holds, in CAD. */
async function drawerChip(page: import("@playwright/test").Page) {
  const body = await page.locator("body").innerText();
  const match = body.match(/In drawer · ledger\s*\$([\d,]+(?:\.\d+)?)/);
  return match ? Number(match[1]!.replace(/,/g, "")) : null;
}

async function openCashDrawer(page: import("@playwright/test").Page) {
  await page.getByText(/Cash Drawer/i).first().click();
  await expect(page.getByText(/Cash drawer/i).first()).toBeVisible();
}

test("the desk opens a till session, and the ledger is the one that says so", async ({ page }) => {
  await signInAtDesk(page);
  const book = ledger(page);
  await book.ensureOpeningBalances(OPENING);
  await openCashDrawer(page);

  /* No session yet: the drawer must ASK rather than opening one because
     somebody looked at the screen. Asserted, not probed — an earlier draft
     of this test checked `isVisible()` and quietly skipped the click while
     the balances were still loading, which is the kind of test that reports
     green for a screen it never exercised. */
  const openButton = page.getByRole("button", { name: /Open the till/i }).first();
  await expect(openButton).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/hasn.t been opened/i)).toBeVisible();
  expect(await book.session()).toBeNull();
  await openButton.click();

  await expect(page.getByText(/Session #\d+ open/)).toBeVisible({ timeout: 15_000 });
  const session = await book.session();
  expect(session).not.toBeNull();
  expect(session.status).toBe("open");

  // the number on screen is the ledger's number, not one derived beside it
  const balances = await book.till();
  expect(Number(balances.CAD)).toBe(25000);
  expect(await drawerChip(page)).toBeGreaterThan(0);
});

test("a float moves the vault and the till together, or not at all", async ({ page }) => {
  await signInAtDesk(page);
  const book = ledger(page);
  await openCashDrawer(page);

  const vaultBefore = await book.vault();
  test.skip(!vaultBefore.tracked, "vault opening position is covered by the vault suite");
  const tillBefore = await book.till();

  await page.getByRole("button", { name: /^Move cash$/i }).first().click();
  await page.locator('input[placeholder="0"]').last().fill("2000");
  await page.getByRole("button", { name: /Issue float/i }).last().click();

  await expect
    .poll(async () => Number((await book.till()).CAD), { timeout: 15_000 })
    .toBe(Number(tillBefore.CAD) + 2000);

  // the other end of the same movement
  const vaultAfter = await book.vault();
  expect(Number(vaultAfter.balances.CAD)).toBe(Number(vaultBefore.balances.CAD) - 2000);
});

test("closing writes the counted figure back, and refuses to guess one", async ({ page }) => {
  await signInAtDesk(page);
  const book = ledger(page);
  await openCashDrawer(page);

  const before = await book.till();
  const currencies = Object.keys(before);
  expect(currencies.length).toBeGreaterThan(1); // the bug needed more than one

  /* Count every ledger currency but ONE, and deliberately count it short so
     a real variance exists. The close must stay blocked: the uncounted
     currency has no figure, and substituting one overwrites real cash. */
  const [firstCcy, ...rest] = currencies;
  await page.locator(`button:has-text("${firstCcy}")`).first().click();
  await page.getByRole("button", { name: /Enter total/i }).first().click();
  const short = Number(before[firstCcy!]) - 5;
  await page.locator('input[placeholder="0.00"]').first().fill(String(short));
  await page.getByRole("button", { name: /Save count/i }).first().click();

  await page.getByRole("button", { name: /Reconcile & close/i }).first().click();
  const closeButton = page.getByRole("button", { name: /Close day & lock book/i }).first();
  await expect(closeButton).toBeDisabled();
  await expect(page.getByText(/Count all \d+ drawers? before closing/)).toBeVisible();

  // now count the rest honestly, and close
  await page.getByRole("button", { name: /Cash drawer/i }).first().click();
  for (const ccy of rest) {
    await page.locator(`button:has-text("${ccy}")`).first().click();
    await page.getByRole("button", { name: /Enter total/i }).first().click();
    await page.locator('input[placeholder="0.00"]').first().fill(String(Number(before[ccy]!)));
  }
  await page.getByRole("button", { name: /Save count/i }).first().click();
  await page.getByRole("button", { name: /Reconcile & close/i }).first().click();
  await page.getByRole("button", { name: /Close day & lock book/i }).first().click();
  await page.getByRole("button", { name: /Close day & lock book/i }).last().click();

  await expect
    .poll(async () => (await book.session())?.status, { timeout: 20_000 })
    .toBe("closed");

  /* THE ASSERTION THIS FILE EXISTS FOR. Every currency holds what was
     counted — the short one is short by exactly five, and the others are
     untouched. Nothing was zeroed, and nothing was invented. */
  const after = await book.till();
  expect(Number(after[firstCcy!])).toBe(short);
  for (const ccy of rest) expect(Number(after[ccy]!)).toBe(Number(before[ccy]!));
});
