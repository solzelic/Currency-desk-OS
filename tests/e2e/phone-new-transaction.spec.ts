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

/* The New transaction button starts enabled from this browser's copy of
   the day, then disables when the desk reads that the server has no open
   till. Clicking in that window waits forever: the click is still in
   progress when the button disables. Read the session first. Open it
   when it is shut, and only then click, after the desk's own read of
   that open session has landed. */
async function tillSessionOpen(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const res = await fetch("/api/ledger/till-session");
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body.session && body.session.status === "open");
  });
}

async function openNewTransaction(page: Page): Promise<void> {
  const button = () => page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button()).toBeVisible({ timeout: 30_000 });
  if (!(await tillSessionOpen(page))) {
    const opened = await page.evaluate(async () => {
      const res = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.ok || res.status === 409 ? "open" : await res.text();
    });
    expect(opened, "the till did not open").toBe("open");
    const seen = page.waitForResponse((res) => {
      const url = res.url();
      return url.includes("/api/ledger/till-session")
        && !url.includes("/till-sessions/")
        && res.request().method() === "GET"
        && res.ok();
    });
    await page.reload();
    await seen;
    await landOnDesktop(page);
    await dismissTour(page);
    expect(await tillSessionOpen(page), "till session after open").toBe(true);
  }
  await expect(button()).toBeEnabled({ timeout: 30_000 });
  await button().click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await dismissTour(page);
}

async function expectPhoneDate(page: Page): Promise<void> {
  const head = page.locator(".cd-tx-head");
  await expect(head).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(head).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
}

/* The post button, measured where it is. Do not scroll it into view:
   the failure this catches is a footer that only appears after a scroll. */
async function expectPrimaryInViewport(page: Page): Promise<void> {
  const box = await page.locator(".cd-tx-go").boundingBox();
  const view = page.viewportSize();
  expect(box, "primary button").toBeTruthy();
  expect(view, "viewport").toBeTruthy();
  expect(box!.x, "primary left").toBeGreaterThanOrEqual(-1);
  expect(box!.y, "primary top").toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, "primary right").toBeLessThanOrEqual(view!.width + 1);
  expect(box!.y + box!.height, "primary bottom").toBeLessThanOrEqual(view!.height + 1);
  expect(box!.height, "primary height").toBeGreaterThanOrEqual(44);
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
    await expectPhoneDate(page);

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
    const chipInset = await page.locator(".cd-tx-types").evaluate((el) => {
      const first = el.querySelector("button");
      if (!(first instanceof HTMLElement)) return -1;
      return first.getBoundingClientRect().left - el.getBoundingClientRect().left;
    });
    expect(chipInset, `first chip inset at ${width}`).toBeGreaterThanOrEqual(16);
    const typePos = await page.locator(".cd-tx-types-bar").evaluate((el) => getComputedStyle(el).position);
    expect(typePos, `type bar pinned at ${width}`).not.toBe("sticky");
    const sheet = await boxOf(page, ".cd-tx");
    expect(sheet.x, `sheet left at ${width}`).toBeLessThanOrEqual(1);
    expect(sheet.y, `sheet top at ${width}`).toBeLessThanOrEqual(1);
    expect(sheet.width, `sheet width at ${width}`).toBeGreaterThanOrEqual(width - 1);
    expect(sheet.height, `sheet height at ${width}`).toBeGreaterThanOrEqual(843);
    await expect(page.locator(".cd-tx").getByRole("button", { name: /^Cancel$/ })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Discard this deal?" })).toHaveCount(0);

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
    const mids = [icon, name, clear].map((b) => b.y + b.height / 2);
    expect(Math.max(...mids) - Math.min(...mids), `customer row at ${width}`).toBeLessThanOrEqual(4);
    expect(clear.width, `clear hit at ${width}`).toBeGreaterThanOrEqual(44);
    expect(clear.height, `clear hit at ${width}`).toBeGreaterThanOrEqual(44);
    const row = await customer.boundingBox();
    expect(row!.height, `customer field height at ${width}`).toBeGreaterThanOrEqual(44);
    expect(row!.height, `customer field height at ${width}`).toBeLessThanOrEqual(52);

    await page.locator(".cd-money input").first().click();
    await expect(page.locator(".cd-tx-suggest")).toBeHidden();
    expect(await horizontalProblems(page), `customer at ${width}`).toEqual([]);

    await page.locator(".cd-money input").first().fill("3000");
    await page.locator(".cd-money input").first().blur();
    await expect(page.locator(".cd-money input").first()).toHaveValue("3000");
    await page.locator(".cd-money input").first().focus();
    await expectPrimaryInViewport(page);
    if (width === 360) {
      await page.setViewportSize({ width: 360, height: 780 });
      await page.locator(".cd-money input").first().focus();
      await expectPrimaryInViewport(page);
      await page.setViewportSize({ width: 360, height: 500 });
      await page.locator(".cd-money input").first().focus();
      await expectPrimaryInViewport(page);
      await page.setViewportSize({ width: 360, height: 844 });
      await page.locator(".cd-tx-scroll").evaluate((el) => { el.scrollTop = 0; });
    }
    await expect(page.locator(".cd-tx-id-type")).toHaveCount(0);
    await expect(page.locator(".cd-tx-id-num")).toHaveCount(0);
    const idNeed = page.locator(".cd-tx-id-need");
    await idNeed.scrollIntoViewIfNeeded();
    await expect(idNeed).toBeVisible();
    const idText = (await idNeed.innerText()).replace(/\s+/g, " ");
    expect(
      idText.includes("ID needed for this amount") || idText.includes("on file"),
      `id row at ${width}: ${idText}`,
    ).toBe(true);
    if (idText.includes("ID needed for this amount")) {
      await expect(idNeed.getByRole("button", { name: "Record the ID" })).toBeVisible();
    }
    const idLine = page.locator(".cd-tx").getByText(/Customer identified|ID required/i).first();
    await idLine.scrollIntoViewIfNeeded();
    await expect(idLine).toBeVisible();
    if (hasLedger) {
      await page.locator(".cd-tx-purpose").scrollIntoViewIfNeeded();
      await expect(page.locator(".cd-tx-purpose")).toBeVisible();
      await expect(page.locator(".cd-tx-purpose")).toHaveAttribute("placeholder", "e.g. vacation, invoice");
      await expect(page.locator(".cd-tx-source")).toHaveAttribute("placeholder", "e.g. salary, savings");
      const before = await page.locator(".cd-tx-purpose").evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(before, `purpose border before touch at ${width}`).not.toBe("rgb(192, 57, 43)");
      await page.locator(".cd-tx-purpose").focus();
      await page.locator(".cd-tx-purpose").blur();
      const after = await page.locator(".cd-tx-purpose").evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(after, `purpose border after touch at ${width}`).toBe("rgb(192, 57, 43)");
      await expect(page.locator(".cd-tx-facts-intro")).toHaveCount(2);
      const intro = await page.locator(".cd-tx-facts-intro").first().evaluate((el) => getComputedStyle(el).display);
      expect(intro, `ledger intro hidden at ${width}`).toBe("none");
    }
    await expect(page.locator(".cd-tx-nudge")).toHaveCount(0);
    await expect(page.getByText("$6.99")).toHaveCount(0);
    await expect(page.locator(".cd-tx")).not.toContainText("$6.99");
    await expect(page.getByRole("button", { name: /^Text quote$/ })).toHaveCount(0);
    /* The payout on the sheet is the figure of record. This preview
       pays 2,166.75 USD for 3,000.00 CAD, so the rate beside it is
       0.7223. The board field is a different figure. A fifth decimal,
       or that board rate in place of 0.7223, fails this. A server
       quote of 2,166.31 shows 0.7221; that pair is in the rate unit test. */
    const rateKicker = page.locator(".cd-tx-rate-line .cd-tx-kicker");
    await expect(page.locator(".cd-tx-receive")).toHaveText("2,166.75");
    await expect(rateKicker).toHaveText("1 CAD = 0.7223 USD");
    await expect(rateKicker).not.toContainText(/\d\.\d{5}/);
    await expect(page.locator(".cd-tx-ticket")).toContainText("1 CAD = 0.7223 USD");
    await expect(page.locator(".cd-tx-ticket")).not.toContainText(/\d\.\d{5}/);
    const board = await page.locator(".cd-tx-rate").inputValue();
    expect(await rateKicker.innerText(), `board rate next to the payout at ${width}`).not.toBe(`1 CAD = ${board} USD`);
    await expect(page.getByText("Board rate").first()).toBeVisible();
    await expect(page.locator(".cd-tx")).not.toContainText("Published rate");
    await expect(page.locator(".cd-tx-rate-line")).not.toContainText("rounded");
    await expect(page.locator(".cd-tx-side")).toContainText(/We (buy|sell) [A-Z]{3}/);
    const sidePaint = await page.locator(".cd-tx-side").evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, bg: s.backgroundColor, size: s.fontSize, lh: s.lineHeight, weight: s.fontWeight, transform: s.textTransform };
    });
    expect(sidePaint, `sell badge at ${width}`).toEqual({
      color: "rgb(122, 62, 150)",
      bg: "rgb(243, 234, 247)",
      size: "12px",
      lh: "16px",
      weight: "600",
      transform: "none",
    });
    await page.locator(".cd-tx-swap").scrollIntoViewIfNeeded();
    await page.locator(".cd-tx-swap").click();
    await expect(page.locator(".cd-tx-side")).toContainText(/We buy [A-Z]{3}/);
    const buyPaint = await page.locator(".cd-tx-side").evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, bg: s.backgroundColor };
    });
    expect(buyPaint, `buy badge at ${width}`).toEqual({
      color: "rgb(30, 90, 168)",
      bg: "rgb(232, 240, 251)",
    });
    expect(buyPaint.color, `buy badge is not the sell colour at ${width}`).not.toBe("rgb(122, 62, 150)");
    await page.locator(".cd-tx-swap").click();
    await expect(page.locator(".cd-tx-side")).toContainText(/We sell [A-Z]{3}/);
    const quiet = await page.locator(".cd-tx-quiet").evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
    expect(quiet.length, `quiet lines at ${width}`).toBeGreaterThan(0);
    expect(quiet.every((c) => c === "rgb(107, 103, 96)"), `quiet ink at ${width}: ${quiet.join(", ")}`).toBe(true);
    const receive = await page.locator(".cd-tx-receive").evaluate((el) => getComputedStyle(el).color);
    expect(receive, `receive field at ${width}`).toBe("rgb(17, 17, 17)");
    const ticketGet = await page.locator(".cd-tx-ticket-get").evaluate((el) => getComputedStyle(el).color);
    expect(ticketGet, `ticket receive at ${width}`).toBe("rgb(255, 255, 255)");
    const kicker = await page.locator(".cd-tx-kicker").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { size: s.fontSize, lh: s.lineHeight, weight: s.fontWeight, transform: s.textTransform, mono: /mono/i.test(s.fontFamily) };
    });
    expect(kicker, `kicker at ${width}`).toEqual({ size: "13px", lh: "16px", weight: "500", transform: "none", mono: false });
    await expect(page.getByText("Margin", { exact: true })).toBeVisible();
    await expect(page.getByText("Before you post", { exact: true })).toBeVisible();
    if (hasLedger) {
      const jump = page.getByRole("button", { name: /Purpose and source of funds/ });
      await expect(jump).toContainText("Needed for this amount");
      const jumpBox = await jump.boundingBox();
      expect(jumpBox!.height, `purpose jump at ${width}`).toBeGreaterThanOrEqual(44);
      await page.locator(".cd-tx-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await jump.scrollIntoViewIfNeeded();
      const before = await page.locator(".cd-tx-scroll").evaluate((el) => el.scrollTop);
      await jump.click();
      await expect(page.locator(".cd-tx-purpose")).toBeFocused();
      const after = await page.locator(".cd-tx-scroll").evaluate((el) => el.scrollTop);
      expect(after, `checklist scrolls to the fields at ${width}`).toBeLessThan(before);
      const view = page.viewportSize();
      for (const sel of [".cd-tx-purpose", ".cd-tx-source"]) {
        const box = await page.locator(sel).boundingBox();
        expect(box, sel).toBeTruthy();
        expect(box!.y, sel).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height, sel).toBeLessThanOrEqual(view!.height);
      }
    }
    await expect(page.locator(".cd-tx-ticket")).toContainText(/\d[\d,]*\.\d{2} [A-Z]{3}/);
    await expect(page.locator(".cd-tx").getByText("ID not recorded yet")).toBeVisible();
    await expect(page.locator(".cd-tx").getByText(/Their ID is/)).toHaveCount(0);
    await expect(page.locator(".cd-tx-note")).toHaveAttribute("placeholder", "Add a note");
    await expectWideFields(page);
    expect(await horizontalProblems(page), `amount and ID at ${width}`).toEqual([]);

    const action = page.locator(".cd-tx-actions").getByRole("button", { name: /steps? left|to complete|server quote|Record transaction|Post frozen/i });
    await expect(action).toBeVisible();
    await expect(action).toBeEnabled();
    await expect(action).toHaveText(hasLedger ? "2 steps left" : "1 step left");
    await page.locator(".cd-tx-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const beforeSteps = await page.locator(".cd-tx-scroll").evaluate((el) => el.scrollTop);
    await action.click();
    const afterSteps = await page.locator(".cd-tx-scroll").evaluate((el) => el.scrollTop);
    expect(afterSteps, `steps left scrolls to the first missing item at ${width}`).toBeLessThan(beforeSteps);
    const missing = page.locator(".cd-tx-missing").first();
    await expect(missing).toBeVisible();
    const missBox = await missing.boundingBox();
    const stepView = page.viewportSize();
    expect(missBox!.y, "missing item top").toBeGreaterThanOrEqual(0);
    expect(missBox!.y + missBox!.height, "missing item bottom").toBeLessThanOrEqual(stepView!.height);
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

    const close = await boxOf(page, ".cd-tx-x");
    expect(close.width, `close hit at ${width}`).toBeGreaterThanOrEqual(44);
    expect(close.height, `close hit at ${width}`).toBeGreaterThanOrEqual(44);
    const swap = page.locator(".cd-tx-swap");
    await swap.scrollIntoViewIfNeeded();
    const swapBox = await swap.boundingBox();
    const rateLine = await boxOf(page, ".cd-tx-rate-line");
    expect(swapBox!.width, `swap hit at ${width}`).toBeGreaterThanOrEqual(44);
    expect(swapBox!.height, `swap hit at ${width}`).toBeGreaterThanOrEqual(44);
    expect(Math.abs((swapBox!.y + swapBox!.height / 2) - (rateLine.y + rateLine.height / 2)), `swap centred at ${width}`).toBeLessThanOrEqual(4);
    const override = page.getByRole("button", { name: /^Override$/ });
    await override.scrollIntoViewIfNeeded();
    const overrideBox = await override.boundingBox();
    expect(overrideBox!.width, `override hit at ${width}`).toBeGreaterThanOrEqual(44);
    expect(overrideBox!.height, `override hit at ${width}`).toBeGreaterThanOrEqual(44);

    await page.locator(".cd-tx-x").click();
    const discard = page.getByRole("dialog", { name: "Discard this deal?" });
    await expect(discard).toBeVisible();
    await expect(discard.getByRole("button", { name: "Discard" })).toBeVisible();
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(discard).toBeHidden();
    await expect(page.locator(".cd-money input").first()).toHaveValue("3000");
    await expect(page.locator(".cd-tx")).toBeVisible();
  }
});

test("recording an ID from the phone deal writes the document", async ({ page }) => {
  test.skip(!hasLedger, "no ledger");
  test.setTimeout(90_000);
  const name = "Phone Id Rowan " + Date.now().toString(36);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.context().clearCookies();
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  await openNewTransaction(page);
  await page.locator(".cd-tx-customer input").fill(name);
  await page.locator(".cd-money input").first().click();
  await page.locator(".cd-money input").first().fill("3000");
  const record = page.locator(".cd-tx-id-need").getByRole("button", { name: "Record the ID" });
  await record.scrollIntoViewIfNeeded();
  await record.click();
  const sheet = page.locator(".cd-tx-record");
  await expect(sheet.getByRole("dialog", { name: "Record the ID" })).toBeVisible();
  const subtitle = sheet.locator(".cd-tx-record-sub-short");
  await expect(subtitle).toHaveText("Type, number and expiry");
  const clipped = await subtitle.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  expect(clipped, "ID subtitle clipped").toBe(false);
  await expect(sheet.locator(".cd-tx-record-sub-long")).toBeHidden();
  const idType = sheet.locator("select").first();
  const typeBox = await idType.boundingBox();
  expect(typeBox!.width, "ID type width").toBeGreaterThanOrEqual(240);
  const columns = await idType.evaluate((el) => {
    const grid = el.closest(".grid");
    return grid ? getComputedStyle(grid).gridTemplateColumns : "";
  });
  expect(columns.trim().split(/\s+/).length, `ID sheet columns: ${columns}`).toBe(1);
  await idType.selectOption("Driver's Licence");
  await sheet.getByLabel("ID number").fill("DL-778899");
  await sheet.getByLabel("Expiry").fill("2030-04-01");
  const saved = page.waitForResponse((res) =>
    /\/api\/clients\/[^/]+\/documents/.test(res.url()) && res.request().method() === "POST" && res.ok());
  await sheet.getByRole("button", { name: "Save and return" }).click();
  await saved;
  await expect(sheet).toBeHidden();
  await expect(page.locator(".cd-tx-id-need")).toContainText("Driver's Licence");
  await expect(page.locator(".cd-tx-id-need")).toContainText("Apr 1, 2030");
  await expect(page.locator(".cd-tx-stats")).toContainText("ID on file");
  await expect(page.locator(".cd-tx-stats")).toContainText(/Last \d+ days/);
  expect(await page.locator(".cd-tx-stat-label").first().evaluate((el) => getComputedStyle(el).textTransform), "stat label case").toBe("none");
  await expect(page.locator(".cd-tx-stats")).toContainText("Apr 1, 2030");
  const document = await page.evaluate(async (who) => {
    const res = await fetch("/api/clients/lookup?name=" + encodeURIComponent(who));
    const body = await res.json();
    const client = (body.clients || [])[0];
    if (!client) return null;
    const primary = (client.documents || []).find((d: { isPrimary?: boolean }) => d.isPrimary) || (client.documents || [])[0];
    return primary ? { docType: primary.docType, docNumber: primary.docNumber, expiresOn: primary.expiresOn } : null;
  }, name);
  expect(document).toEqual({ docType: "Driver's Licence", docNumber: "DL-778899", expiresOn: "2030-04-01" });
});

test("recording an ID on an existing customer stays on that file", async ({ page }) => {
  test.skip(!hasLedger, "no ledger");
  test.setTimeout(90_000);
  const name = "Phone File " + Date.now().toString(36);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.context().clearCookies();
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  const created = await page.evaluate(async (legalName) => {
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName, kind: "individual" }),
    });
    const body = await res.json();
    return { status: res.status, clientId: body.clientId as string };
  }, name);
  expect(created.status, "create client").toBe(201);
  expect(created.clientId).toMatch(/^cli_/);
  await openNewTransaction(page);
  await page.locator(".cd-tx-customer input").fill(name);
  await page.locator(".cd-money input").first().click();
  await page.locator(".cd-money input").first().fill("3000");
  const record = page.locator(".cd-tx-id-need").getByRole("button", { name: "Record the ID" });
  await record.scrollIntoViewIfNeeded();
  await record.click();
  const sheet = page.locator(".cd-tx-record");
  await expect(sheet.getByRole("dialog", { name: "Record the ID" })).toBeVisible();
  await sheet.locator("select").first().selectOption("Passport");
  await sheet.getByLabel("ID number").fill("PP-100200");
  await sheet.getByLabel("Expiry").fill("2031-06-15");
  const saved = page.waitForResponse((res) =>
    res.request().method() === "POST" && res.ok() && /\/api\/clients\/[^/]+\/documents/.test(res.url()));
  await sheet.getByRole("button", { name: "Save and return" }).click();
  const response = await saved;
  expect(response.url(), "document posted on the original file").toContain("/api/clients/" + created.clientId + "/documents");
  const looked = await page.evaluate(async (who) => {
    const res = await fetch("/api/clients/lookup?name=" + encodeURIComponent(who));
    const body = await res.json();
    return (body.clients || []).map((c: { clientId: string }) => c.clientId);
  }, name);
  expect(looked).toEqual([created.clientId]);
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
  await expect(page.locator(".cd-tx-head")).toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(page.locator(".cd-tx-note")).toHaveAttribute("placeholder", "Anything worth keeping on the record…");
  await expect(page.locator(".cd-tx-cancel")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Text quote$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /steps left/ })).toHaveCount(0);
  await expect(page.locator(".cd-tx-go")).toBeDisabled();
  await expect(page.locator(".cd-tx-go")).toContainText(/to complete/);
  const side = page.locator(".cd-tx-side");
  await expect(side).toContainText(/We (buy|sell)/);
  expect(await side.evaluate((el) => getComputedStyle(el).textTransform), "desk badge").toBe("uppercase");
  expect(await page.locator(".cd-tx-receive").evaluate((el) => getComputedStyle(el).color), "desk receive").toBe("rgb(31, 138, 76)");
  expect(await page.locator(".cd-tx-ticket-get").evaluate((el) => getComputedStyle(el).color), "desk ticket").toBe("rgb(127, 209, 163)");
  if (hasLedger) {
    await expect(page.locator(".cd-tx-purpose")).toBeAttached();
    const border = await page.locator(".cd-tx-purpose").evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(border, "desk purpose border").toBe("rgb(192, 57, 43)");
    await expect(page.locator(".cd-tx-facts-intro").first()).toBeVisible();
    await expect(page.getByText("Ledger facts captured")).toBeVisible();
    await expect(page.getByRole("button", { name: /Purpose and source of funds/ })).toHaveCount(0);
  }
});
