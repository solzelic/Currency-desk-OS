/* New transaction was a 940px dialog with a 320px ticket beside the
   fields. At 390 that left the customer and the amount about 20px
   wide, so a teller could not reach the ID line. Under 600px the
   ticket sits under the form. This walks that dialog as m.costa.
   Wider than 600px the ticket stays beside the form. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop, hasLedger } from "./fixtures";

const WIDTHS = [390, 360] as const;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function openNewTransaction(page: Page): Promise<void> {
  const button = () => page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button()).toBeVisible({ timeout: 30_000 });
  if (await button().isDisabled()) {
    const opened = await page.evaluate(async () => {
      const res = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.ok || res.status === 409 ? "open" : await res.text();
    });
    expect(opened, "the till did not open").toBe("open");
    await page.reload();
    await landOnDesktop(page);
    await dismissTour(page);
  }
  await button().scrollIntoViewIfNeeded();
  await expect(button()).toBeEnabled();
  await button().click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await dismissTour(page);
}

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, selector).toBeTruthy();
  return box!;
}

/* A field cut off by overflow:hidden is not a field the cashier can
   use, even when the page itself does not scroll sideways. */
async function horizontalProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > limit) {
      problems.push("page scrollWidth " + document.documentElement.scrollWidth);
    }
    const interactive = "button, a, input, select, textarea";
    const root = document.querySelector(".cd-tx");
    if (!root) return ["dialog missing"];
    for (const el of root.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.right > limit || rect.left < -1) {
        problems.push(el.tagName.toLowerCase() + " right=" + Math.round(rect.right));
      }
      if (!el.matches(interactive)) continue;
      let node: HTMLElement | null = el.parentElement;
      while (node && node !== document.body) {
        const parent = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const outside = rect.right > box.right + 1 || rect.left < box.left - 1;
        if ((parent.overflowX === "hidden" || parent.overflowX === "clip") && outside) {
          problems.push("clipped " + el.tagName.toLowerCase());
          break;
        }
        node = node.parentElement;
      }
      if (problems.length >= 6) break;
    }
    return problems;
  });
}

async function expectWideFields(page: Page): Promise<void> {
  const selectors = [
    ".cd-tx-customer input",
    ".cd-money input",
    ".cd-money .flex-1",
    ".cd-tx-rate",
    ".cd-tx-fee",
  ];
  if (hasLedger) selectors.push(".cd-tx-purpose", ".cd-tx-source");
  for (const selector of selectors) {
    const box = await boxOf(page, selector);
    expect(box.width, selector).toBeGreaterThanOrEqual(200);
    expect(box.height, selector).toBeGreaterThanOrEqual(44);
  }
  const typed = page.locator(".cd-tx-customer input, .cd-tx-rate, .cd-tx-fee");
  const count = await typed.count();
  for (let i = 0; i < count; i++) {
    const size = await typed.nth(i).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, "field text").toBeGreaterThanOrEqual(16);
  }
}

test("a teller can fill new transaction on a phone", async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.context().clearCookies();
    await signInAtDesk(page, "m.costa");
    await dismissTour(page);
    await openNewTransaction(page);

    const form = await boxOf(page, ".cd-tx-form");
    const rail = await boxOf(page, ".cd-tx-rail");
    expect(rail.y, `rail beside the form at ${width}`).toBeGreaterThanOrEqual(form.y + form.height - 2);
    expect(form.width, `form width at ${width}`).toBeGreaterThanOrEqual(200);
    await expectWideFields(page);
    expect(await horizontalProblems(page), `open at ${width}`).toEqual([]);

    await page.locator(".cd-tx-customer input").fill("Mei Chen");
    await page.locator(".cd-money input").first().click();
    expect(await horizontalProblems(page), `customer at ${width}`).toEqual([]);

    await page.locator(".cd-money input").first().fill("3000");
    const idLine = page.locator(".cd-tx").getByText(/Customer identified|ID required/i).first();
    await idLine.scrollIntoViewIfNeeded();
    await expect(idLine).toBeVisible();
    if (hasLedger) {
      await page.locator(".cd-tx-purpose").scrollIntoViewIfNeeded();
      await expect(page.locator(".cd-tx-purpose")).toBeVisible();
    }
    await expectWideFields(page);
    expect(await horizontalProblems(page), `amount and ID at ${width}`).toEqual([]);

    const action = page.locator(".cd-tx-actions").getByRole("button", { name: /to complete|server quote|Record transaction|Post frozen/i });
    await expect(action).toBeVisible();
    const button = await action.boundingBox();
    expect(button, "post button").toBeTruthy();
    expect(button!.y).toBeGreaterThanOrEqual(0);
    expect(button!.y + button!.height).toBeLessThanOrEqual(844);
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(await horizontalProblems(page), `action at ${width}`).toEqual([]);
  }
});

test("new transaction stays two columns on a desk", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  await openNewTransaction(page);
  const form = await boxOf(page, ".cd-tx-form");
  const rail = await boxOf(page, ".cd-tx-rail");
  expect(rail.width).toBeGreaterThan(300);
  expect(rail.width).toBeLessThan(340);
  expect(rail.x).toBeGreaterThanOrEqual(form.x + form.width - 2);
  expect(form.y).toBeLessThanOrEqual(rail.y + 2);
});
