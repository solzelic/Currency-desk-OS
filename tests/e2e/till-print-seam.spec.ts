/* The Cash Drawer print is a page of the screen, not a second sign-off.
   Expected cash on it has to be the till balance the ledger just returned.
   The count is labelled as what is typed on the screen. The footer names
   the End-of-Day Sign-Off as the signed sheet. See GENERATED_DOCUMENTS.md. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

test("the till print shows the ledger balance and does not pretend to be the sign-off", async ({ page }) => {
  await page.context().addInitScript(() => {
    window.print = () => {};
  });
  await signInAtDesk(page);
  const balances = await page.evaluate(async () => {
    const response = await fetch("/api/ledger/till-balances");
    if (!response.ok) return {};
    const body = await response.json();
    return (body && body.balances) || {};
  });

  await page.locator('[data-app="till"]').click();
  await expect(page.getByText(/Cash Drawer/i).first()).toBeVisible();
  await expect(page.getByText(/server balances live/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Reconcile & close/i }).click();
  const currencies = Object.keys(balances as Record<string, string>);
  if (currencies[0]) {
    await expect(page.getByText(currencies[0], { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  }
  const printButton = page.getByTestId("print-till-summary");
  await printButton.scrollIntoViewIfNeeded();

  const popupPromise = page.waitForEvent("popup");
  await printButton.click();
  const popup = await popupPromise;
  await expect(popup.locator("body")).toContainText("Till count and day summary");
  const text = await popup.locator("body").innerText();
  // KPI labels and table headers are styled uppercase, so innerText
  // returns COUNTED ON SCREEN. The sentence under the count lines stays
  // sentence case. Either form is the same label.
  expect(text.toLowerCase()).toContain("counted on screen");
  expect(text).toContain("End-of-Day Sign-Off");
  expect(text).toContain("never a zero");

  const fmt = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 });
  for (const [currency, raw] of Object.entries(balances as Record<string, string>)) {
    expect(text).toContain(currency);
    const amount = Number(raw);
    if (Number.isFinite(amount)) expect(text).toContain(fmt.format(amount));
  }
});
