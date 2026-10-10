/* Cash Drawer on a phone. At 390 and 360 the count is a selector,
   steppers, and a thumb footer. At 1280 the drawer is the desktop
   one: folder tabs, small steppers, coins open, no phone selector.
   The count still posts to the ledger. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

const PHONE = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

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

async function atDesk(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await settled(page);
}

async function tillOpen(page: Page): Promise<void> {
  const opened = await page.evaluate(async () => {
    const probe = await fetch("/api/ledger/till-session", { credentials: "same-origin" });
    if (!probe.ok) return `session ${probe.status}`;
    const body = await probe.json();
    if (body.session && body.session.status === "open") return "open";
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (res.ok || res.status === 409) return "open";
    return `${res.status} ${await res.text()}`;
  });
  expect(opened, "the populated book did not open a till").toBe("open");
  const sync = page.waitForResponse((r) => r.url().includes("/api/ledger/till-session") && r.ok());
  await page.reload();
  await landOnDesktop(page);
  await sync;
  await dismissTour(page);
  await settled(page);
}

async function openTill(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.locator('#phonebar [data-phone-app="till"]').click();
  } else {
    await page.locator('#appbar [data-app="till"]').click();
  }
  await dismissTour(page);
  await settled(page);
  await expect(page.locator(".till-root")).toBeVisible();
  await expect(page.getByText("server balances unavailable")).toHaveCount(0);
  await expect(page.getByText("This till hasn’t been opened")).toHaveCount(0);
}

/* A sideways page is a failure. A table may scroll inside its own box. */
async function overflowPast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const seen: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      let node: HTMLElement | null = el.parentElement;
      let contained = false;
      while (node && node !== document.body) {
        const parent = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const scrolls = parent.overflowX === "auto" || parent.overflowX === "scroll";
        if (scrolls && box.right <= limit + 1 && box.left >= -1) {
          contained = true;
          break;
        }
        node = node.parentElement;
      }
      if (rect.right > limit && !contained) {
        const name = (el.id ? "#" + el.id : el.tagName.toLowerCase()) + "." + String(el.className).slice(0, 40);
        seen.push(name + " right=" + Math.round(rect.right));
        if (seen.length >= 6) break;
      }
    }
    return seen;
  });
}

async function countCad(page: Page): Promise<void> {
  const add = page.getByRole("button", { name: "Add one $100 CAD" });
  await add.click();
  await add.click();
  await expect(page.getByRole("spinbutton", { name: "$100 CAD count" })).toHaveValue("2");
  await expect(page.locator(".till-den").first().locator(".till-den-sub")).toHaveText("200");
  await expect(page.locator(".till-counted-input")).toHaveValue("200");
}

test("a phone can count, save, and reach every till tab", async ({ page }) => {
  test.setTimeout(120_000);
  for (const size of PHONE) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await atDesk(page);
    await tillOpen(page);
    await openTill(page, true);

    await expect(page.locator(".till-phone-who")).toContainText("On the drawer");
    await expect(page.locator(".till-phone-who")).toContainText("A. Singh");
    await expect(page.locator(".till-phone-who")).toContainText("Senior teller");
    await expect(page.locator(".till-phone-who")).toContainText("Till 1");
    const whoClipped = await page.locator(".till-phone-who").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(whoClipped, "the who-line wraps or clips").toBe(false);

    const past = await overflowPast(page);
    expect(past, "horizontal overflow at " + size.width).toEqual([]);
    await expect(page.locator(".win.show.active .win-resize")).toBeHidden();

    const chip = await page.locator(".till-chip").first().boundingBox();
    expect(chip && chip.height).toBeGreaterThanOrEqual(44);
    const step = await page.locator(".till-den .till-step").first().boundingBox();
    expect(step && step.width).toBeGreaterThanOrEqual(44);
    expect(step && step.height).toBeGreaterThanOrEqual(44);
    const whoSize = await page.locator(".till-phone-who").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(whoSize).toBeGreaterThanOrEqual(15);

    await expect(page.locator(".till-coins")).toBeHidden();
    await page.locator(".till-coins-btn").click();
    await expect(page.locator(".till-coins")).toBeVisible();
    await page.locator(".till-coins-btn").click();

    await countCad(page);
    const usd = page.getByRole("button", { name: "USD", exact: true });
    await usd.click();
    await page.getByRole("button", { name: "Add one $50 USD" }).click();
    await expect(page.locator(".till-counted-input")).toHaveValue("50");

    const posted = page.waitForResponse((r) => r.url().includes("/api/ledger/till-counts") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save count" }).click();
    const res = await posted;
    expect(res.ok(), await res.text()).toBeTruthy();
    const tally = await page.evaluate(async () => {
      const r = await fetch("/api/ledger/till-session", { credentials: "same-origin" });
      return r.json();
    });
    const counts = tally.latestCounts || {};
    expect(Object.keys(counts).sort()).toEqual(expect.arrayContaining(["CAD", "USD"]));
    expect(Number(counts.CAD.counted)).toBe(200);
    expect(Number(counts.USD.counted)).toBe(50);

    await page.locator(".till-phone-select").click();
    await expect(page.locator(".till-sheet")).toBeVisible();
    await page.locator(".till-sheet").getByRole("button", { name: "Reconcile & close" }).click();
    await expect(page.locator(".till-table-scroll")).toBeVisible();
    await expect(page.locator(".till-table-scroll")).toContainText("200");
    await expect(page.locator(".till-table-scroll")).toContainText("50");
    const reconPast = await overflowPast(page);
    expect(reconPast, "reconcile overflow").toEqual([]);

    await page.locator(".till-phone-select").click();
    await page.locator(".till-sheet").getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText("Shift handoffs")).toBeVisible();
    const histPast = await overflowPast(page);
    expect(histPast, "history overflow").toEqual([]);

    await page.locator(".till-phone-select").click();
    await page.locator(".till-sheet").getByRole("button", { name: "Cash drawer", exact: true }).click();
    await expect(page.locator(".till-counted-input")).toBeVisible();

    const saveBox = await page.getByRole("button", { name: "Save count" }).boundingBox();
    const fabBox = await page.locator("#phone-fab").boundingBox();
    const hits =
      !!saveBox &&
      !!fabBox &&
      saveBox.x < fabBox.x + fabBox.width - 1 &&
      saveBox.x + saveBox.width > fabBox.x + 1 &&
      saveBox.y < fabBox.y + fabBox.height - 1 &&
      saveBox.y + saveBox.height > fabBox.y + 1;
    expect(hits, "Save count collides with the round +").toBe(false);

    const expected = page.locator(".till-expected-fig");
    const blurred = await expected.evaluate((el) => getComputedStyle(el).filter.includes("blur"));
    expect(blurred).toBe(true);
    await page.locator(".till-expected").click();
    const shown = await expected.evaluate((el) => getComputedStyle(el).filter === "none" || !getComputedStyle(el).filter.includes("blur"));
    expect(shown).toBe(true);
  }
});

test("the desktop cash drawer is unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await tillOpen(page);
  await openTill(page, false);

  await expect(page.locator(".till-phone-select")).toBeHidden();
  await expect(page.locator(".till-phone-who")).toBeHidden();
  await expect(page.locator(".till-coins-btn")).toBeHidden();
  await expect(page.locator(".till-handoff-phone")).toBeHidden();
  await expect(page.locator(".till-sheet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cash drawer", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconcile & close", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "History", exact: true })).toBeVisible();
  await expect(page.locator(".till-coins")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hand off" })).toBeVisible();

  const step = await page.locator(".till-den .till-step").first().boundingBox();
  expect(Math.round(step?.width || 0)).toBe(26);
  expect(Math.round(step?.height || 0)).toBe(28);
  await expect(page.locator(".win.show.active .win-bar")).toBeVisible();
  await expect(page.locator(".win.show.active .win-resize")).toBeVisible();
});
