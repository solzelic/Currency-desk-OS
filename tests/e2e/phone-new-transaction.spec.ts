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
      /* The type chips are a horizontal scroller. A chip past the
         right edge is the next one, not a page overflow. */
      if (el.closest(".cd-tx-types")) continue;
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
  const customer = await boxOf(page, ".cd-tx-customer");
  expect(customer.width, "customer field").toBeGreaterThanOrEqual(200);
  expect(customer.height, "customer field").toBeGreaterThanOrEqual(44);
  const name = await boxOf(page, ".cd-tx-customer input");
  expect(name.width, "customer name").toBeGreaterThanOrEqual(200);
  const selectors = [
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

    const typeButtons = page.locator(".cd-tx-types button");
    expect(await typeButtons.count()).toBe(6);
    const typeBoxes = await typeButtons.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.querySelector("span") || el;
      /* The 44px hit area sticks out of the 36px pill. The name is
         what must not be cut off. */
      return { top: r.top, width: r.width, text: (el.textContent || "").trim(), clipped: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 };
    }));
    expect(Math.max(...typeBoxes.map((b) => b.top)) - Math.min(...typeBoxes.map((b) => b.top)), `type chips on one row at ${width}`).toBeLessThanOrEqual(4);
    expect(Math.min(...typeBoxes.map((b) => b.width)), `type chip width at ${width}`).toBeGreaterThanOrEqual(40);
    expect(typeBoxes.filter((b) => b.clipped).map((b) => b.text), `type names clipped at ${width}`).toEqual([]);
    const chipRow = await page.locator(".cd-tx-types").evaluate((el) => {
      const style = getComputedStyle(el);
      const selected = el.querySelector(".is-on");
      const row = el.getBoundingClientRect();
      const chip = selected instanceof HTMLElement ? selected.getBoundingClientRect() : null;
      return {
        overflowX: style.overflowX,
        snap: style.scrollSnapType,
        wrap: style.flexWrap,
        scrolls: el.scrollWidth > el.clientWidth + 1,
        selectedInView: !!chip && chip.left >= row.left - 1 && chip.right <= row.right + 1,
      };
    });
    expect(chipRow.overflowX, `chip row scrolls at ${width}`).toBe("auto");
    /* Chrome serializes the proximity default as "x". "x mandatory"
       would be a different snap. */
    expect(chipRow.snap === "x" || chipRow.snap === "x proximity", `chip snap at ${width}: ${chipRow.snap}`).toBe(true);
    expect(chipRow.wrap, `chip row nowrap at ${width}`).toBe("nowrap");
    expect(chipRow.scrolls, `chip row overflows at ${width}`).toBe(true);
    expect(chipRow.selectedInView, `selected chip in view at ${width}`).toBe(true);
    const typePos = await page.locator(".cd-tx-types-bar").evaluate((el) => getComputedStyle(el).position);
    expect(typePos, `type bar pinned at ${width}`).not.toBe("sticky");
    const sheet = await boxOf(page, ".cd-tx");
    expect(sheet.x, `sheet left at ${width}`).toBeLessThanOrEqual(1);
    expect(sheet.y, `sheet top at ${width}`).toBeLessThanOrEqual(1);
    expect(sheet.width, `sheet width at ${width}`).toBeGreaterThanOrEqual(width - 1);
    expect(sheet.height, `sheet height at ${width}`).toBeGreaterThanOrEqual(843);
    await expect(page.locator(".cd-tx").getByRole("button", { name: /^Cancel$/ })).toHaveCount(0);

    const form = await boxOf(page, ".cd-tx-form");
    const rail = await boxOf(page, ".cd-tx-rail");
    expect(rail.y, `rail beside the form at ${width}`).toBeGreaterThanOrEqual(form.y + form.height - 2);
    expect(form.width, `form width at ${width}`).toBeGreaterThanOrEqual(200);
    await expectWideFields(page);
    expect(await horizontalProblems(page), `open at ${width}`).toEqual([]);

    const customer = page.locator(".cd-tx-customer");
    await customer.locator("input").fill("Mei Chen");
    await expect(page.locator(".cd-tx-suggest")).toBeVisible();
    const icon = await boxOf(page, ".cd-tx-customer svg");
    const name = await boxOf(page, ".cd-tx-customer input");
    const clear = await boxOf(page, ".cd-tx-customer button");
    const tops = [icon.y, name.y, clear.y];
    expect(Math.max(...tops) - Math.min(...tops), `customer row at ${width}`).toBeLessThanOrEqual(4);
    const row = await customer.boundingBox();
    expect(row!.height, `customer field height at ${width}`).toBeGreaterThanOrEqual(44);
    expect(row!.height, `customer field height at ${width}`).toBeLessThanOrEqual(52);

    await page.locator(".cd-money input").first().click();
    await expect(page.locator(".cd-tx-suggest")).toBeHidden();
    expect(await horizontalProblems(page), `customer at ${width}`).toEqual([]);

    await page.locator(".cd-money input").first().fill("3000");
    const idLine = page.locator(".cd-tx").getByText(/Customer identified|ID required/i).first();
    await idLine.scrollIntoViewIfNeeded();
    await expect(idLine).toBeVisible();
    if (hasLedger) {
      await page.locator(".cd-tx-purpose").scrollIntoViewIfNeeded();
      await expect(page.locator(".cd-tx-purpose")).toBeVisible();
      await expect(page.locator(".cd-tx-purpose")).toHaveAttribute("placeholder", "e.g. vacation, invoice");
      await expect(page.locator(".cd-tx-source")).toHaveAttribute("placeholder", "e.g. salary, savings");
    }
    await expect(page.locator(".cd-tx-note")).toHaveAttribute("placeholder", "Add a note");
    await expectWideFields(page);
    expect(await horizontalProblems(page), `amount and ID at ${width}`).toEqual([]);

    const action = page.locator(".cd-tx-actions").getByRole("button", { name: /to complete|server quote|Record transaction|Post frozen/i });
    await expect(action).toBeVisible();
    const button = await action.boundingBox();
    expect(button, "post button").toBeTruthy();
    expect(button!.y).toBeGreaterThanOrEqual(0);
    expect(button!.y + button!.height).toBeLessThanOrEqual(844);
    expect(button!.height).toBeGreaterThanOrEqual(44);
    const footer = await boxOf(page, ".cd-tx-actions");
    expect(footer.height, `footer at ${width}`).toBeLessThanOrEqual(160);

    /* Scroll to the end of the phone dialog. The note is the last
       field. It has to sit fully above the sticky post bar, not
       underneath it. */
    await page.locator(".cd-tx-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const note = await boxOf(page, ".cd-tx-note");
    const bar = await boxOf(page, ".cd-tx-actions");
    const scroll = await boxOf(page, ".cd-tx-scroll");
    expect(note.y, `note top at ${width}`).toBeGreaterThanOrEqual(scroll.y - 1);
    expect(note.y + note.height, `note above the footer at ${width}`).toBeLessThanOrEqual(bar.y + 1);
    expect(note.height, `note fully shown at ${width}`).toBeGreaterThanOrEqual(44);
    const types = await boxOf(page, ".cd-tx-types-bar");
    expect(types.y + types.height, `type chips scrolled away at ${width}`).toBeLessThanOrEqual(scroll.y + 1);
    const ticket = await boxOf(page, ".cd-tx-ticket");
    expect(ticket.y, `ticket top at ${width}`).toBeGreaterThanOrEqual(scroll.y - 1);
    expect(ticket.y + ticket.height, `ticket above the footer at ${width}`).toBeLessThanOrEqual(bar.y + 1);
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
  await expect(page.locator(".cd-tx-note")).toHaveAttribute("placeholder", "Anything worth keeping on the record…");
  await expect(page.locator(".cd-tx-cancel")).toBeVisible();
});
