/* Ledger on a phone. At 390 and 360 the book is cards. At 1280 it is
   the table. The deals are posted through the quote path onto this
   spec's own till, so the shop's first drawer — the one cash-seam
   needs never to have been opened — stays untouched. */
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const TILL = "till-phone-cards";

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

/* Post a small book on a till that belongs to this spec, then stand
   the desk on that till. Idempotent: a second call finds the deals. */
async function showBook(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "r.haddad");
  await dismissTour(page);
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith("cdesk.ledger.till.")));
  const ready = await page.evaluate(async (tillId) => {
    const created = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tillId }),
    });
    const made = await created.json().catch(() => ({}));
    const id = made.till?.workspaceId || made.workspaceId;
    if (!id) return { ok: false, why: `till ${created.status} ${JSON.stringify(made)}` };
    const headers: Record<string, string> = { "content-type": "application/json", "x-workspace-id": id };
    await fetch("/api/ledger/opening-balances", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({ balances: { CAD: "25000.00", USD: "8000.00", EUR: "5000.00" } }),
    });
    await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: "{}",
    });
    const listed = await fetch("/api/ledger/transactions?limit=20", { headers, credentials: "same-origin" }).then((r) => r.json());
    const have = (listed.transactions || []).length;
    if (have < 2) {
      const customers = await fetch("/api/ledger/customers", { headers, credentials: "same-origin" }).then((r) => r.json());
      let customerId = customers.customers?.[0]?.customerId as string | undefined;
      if (!customerId) {
        const madeCustomer = await fetch("/api/ledger/customers", {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: JSON.stringify({ externalRef: "phone-cards", name: "Lina Farah", risk: "normal", idStatus: "verified" }),
        });
        const body = await madeCustomer.json().catch(() => ({}));
        if (!madeCustomer.ok) return { ok: false, why: `customer ${madeCustomer.status} ${JSON.stringify(body)}` };
        customerId = body.customerId;
      }
      const deals = [
        { from: "CAD", to: "EUR", inputAmount: "180.00", direction: "customer_buy_foreign", feeCad: "2.50", key: "phone-cards:tx:1" },
        { from: "CAD", to: "USD", inputAmount: "400.00", direction: "customer_buy_foreign", feeCad: "4.00", key: "phone-cards:tx:2" },
      ];
      for (const deal of deals) {
        const quote = await fetch("/api/quotes", {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: JSON.stringify({
            customerId,
            from: deal.from,
            to: deal.to,
            inputAmount: deal.inputAmount,
            direction: deal.direction,
            feeCad: deal.feeCad,
          }),
        });
        if (!quote.ok) return { ok: false, why: `quote ${quote.status} ${await quote.text()}` };
        const frozen = await quote.json();
        const posted = await fetch(`/api/quotes/${frozen.quoteId}/post`, {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: JSON.stringify({ idempotencyKey: deal.key, purpose: "Travel", sourceOfFunds: "Savings" }),
        });
        if (!posted.ok) return { ok: false, why: `post ${posted.status} ${await posted.text()}` };
      }
    }
    const key = Object.keys(localStorage).find((k) => k.startsWith("cdesk.ledger.till."));
    if (key) localStorage.setItem(key, id);
    const again = await fetch("/api/ledger/transactions?limit=20", { headers, credentials: "same-origin" }).then((r) => r.json());
    return { ok: true, id, count: (again.transactions || []).length };
  }, TILL);
  expect(ready.ok, ready.ok ? "" : ready.why).toBe(true);
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await page.waitForFunction((id) => {
    const backend = (window as unknown as { CDOS?: { Backend?: { getWorkspace?: () => string | null } } }).CDOS?.Backend;
    return backend?.getWorkspace?.() === id;
  }, ready.id);
}

async function openLedger(page: Page): Promise<void> {
  const phone = page.locator('#phonebar [data-phone-app="ledger"]');
  if (await phone.isVisible()) await phone.click();
  else await page.locator('#appbar [data-app="ledger"]').click();
  await dismissTour(page);
  await settled(page);
}

async function noSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

test("cards replace the table at 390 and at 360", async ({ page }) => {
  for (const size of [
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await showBook(page);
    await openLedger(page);
    const cards = page.locator(".win.show.active [data-ledger-card]");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".win.show.active table")).toBeHidden();
    await expect(page.locator("[data-ledger-summary]")).toContainText(/\d+ today/);
    const summaryText = await page.locator("[data-ledger-summary]").innerText();
    expect(summaryText.replace(/\s+/g, " ").trim()).toMatch(/\d+ today · .+ in · .+ fees · \d+ reportable/);
    expect(summaryText.split("\n").every((line) => !/^\s*·/.test(line) && !/·\s*$/.test(line))).toBe(true);
    await expect(page.locator("[data-ledger-summary]")).toContainText("fees");
    await expect(page.locator("[data-ledger-summary]")).toContainText("reportable");
    await expect(page.getByPlaceholder("Search the book")).toBeVisible();
    await expect(page.locator("#phone-fab")).toBeVisible();
    const nameSize = await page.locator(".ledger-card-name").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(nameSize).toBeGreaterThanOrEqual(15);
    const pairSize = await page.locator(".ledger-card-pair").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(pairSize).toBeGreaterThanOrEqual(15);
    const filters = await page.locator("[data-ledger-filters]").boundingBox();
    expect(filters && filters.height).toBeGreaterThanOrEqual(44);
    expect(filters && filters.width).toBeGreaterThanOrEqual(44);
    const card = await cards.first().boundingBox();
    expect(card && card.height).toBeGreaterThanOrEqual(44);
    const tab = await page.getByRole("button", { name: "Records", exact: true }).boundingBox();
    expect(tab && tab.height).toBeGreaterThanOrEqual(44);
    const recordsBg = await page.getByRole("button", { name: "Records", exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(recordsBg).toBe("rgb(29, 107, 69)");
    expect(await noSideways(page), `sideways overflow at ${size.width}`).toBe(true);
    const under = await page.evaluate(() => {
      const win = document.querySelector(".win.show.active");
      const dock = document.getElementById("phone-dock");
      if (!win || !dock) return true;
      return win.getBoundingClientRect().bottom > dock.getBoundingClientRect().top + 1;
    });
    expect(under, "the window runs under the bar").toBe(false);
  }
});

test("the filters sheet applies a filter, and a card opens the record", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await showBook(page);
  await openLedger(page);
  const cards = page.locator(".win.show.active [data-ledger-card]");
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();

  await page.locator("[data-ledger-filters]").click();
  const sheet = page.locator("[data-ledger-sheet]");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Generate report" })).toBeVisible();
  await expect(sheet.getByText("Reports work best on a computer")).toBeVisible();
  /* These two deals are under the reporting line, so Reportable is
     empty. Voided is not a safe stand-in: another spec on the same
     database can leave a void on a different drawer, and this check
     is about the filter, not about that drawer. */
  await sheet.getByRole("button", { name: "Reportable", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator("[data-ledger-filters]")).toContainText("Reportable");
  await expect(page.locator("[data-ledger-empty]")).toHaveText("No deals match.");
  await expect(cards).toHaveCount(0);

  await page.locator("[data-ledger-filters]").click();
  await sheet.getByRole("button", { name: "All posted", exact: true }).click();
  await expect(cards).toHaveCount(before);

  await page.getByPlaceholder("Search the book").fill("zzzz-no-such-deal");
  await expect(page.locator("[data-ledger-empty]")).toHaveText("No deals match.");
  await page.getByPlaceholder("Search the book").fill("");
  await expect(cards).toHaveCount(before);

  const ref = (await cards.first().locator(".ledger-card-ref").innerText()).trim();
  await cards.first().click();
  await expect(page.getByRole("button", { name: "Back to records" })).toBeVisible();
  await expect(page.locator(".tx-detail-ref")).toHaveText(ref);
  await page.getByRole("button", { name: "Back to records" }).click();
  await expect(page.getByRole("button", { name: "Back to records" })).toBeHidden();
  await expect(cards.first()).toBeVisible();
  expect(await noSideways(page)).toBe(true);
});

test("at 1280 the table is the ledger", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await showBook(page);
  await openLedger(page);
  await expect(page.locator(".win.show.active table")).toBeVisible();
  await expect(page.locator(".win.show.active thead")).toContainText("Pay-in");
  await expect(page.locator(".win.show.active thead")).toContainText("Customer");
  await expect(page.locator(".ledger-phone")).toBeHidden();
  await expect(page.locator(".win.show.active").getByRole("button", { name: "Generate report" })).toBeVisible();
  await expect(page.locator("#phonebar")).toBeHidden();
});
