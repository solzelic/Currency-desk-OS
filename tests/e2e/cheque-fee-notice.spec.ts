/* The fee notice is a sentence with the lock in the first line.
   On a 360px phone that line has to wrap. A row that runs off the
   screen is the notice cut off, which is what this check refuses. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

test("the fee notice wraps at 360", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signInAtDesk(page, "m.costa");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="cheques"]').click();
  await page.getByRole("button", { name: "Fee schedule" }).click();
  const note = page.getByTestId("fee-schedule-lock");
  await expect(note).toContainText("Ask a manager to make this change.");
  const box = await note.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    const tops = rects.map((r) => Math.round(r.top));
    const lines = tops.filter((t, i) => tops.findIndex((u) => Math.abs(u - t) < 3) === i);
    const edge = document.documentElement.clientWidth;
    return {
      lines: lines.length,
      past: rects.some((r) => r.right > edge + 1 || r.left < -1),
      scroll: el.scrollWidth > el.clientWidth + 1,
      edge,
    };
  });
  expect(box.lines).toBeGreaterThan(1);
  expect(box.past).toBe(false);
  expect(box.scroll).toBe(false);
});

/* Phone widths. Fee % has to be in the layout, and a field has to sit
   inside its cell. A cashier, a teller, and an auditor get the lock
   and no fields. A conflict keeps Reload at least 44px.
   Break, then restored: an absolute 800px .fee-field put 18 inputs
   wider than their cells, and this check failed. */
const PHONE = [360, 390, 430];

async function openFees(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="cheques"]').click();
  await page.getByRole("button", { name: "Fee schedule" }).click();
  await expect(page.getByTestId("fee-schedule")).toBeVisible();
}

async function feeColumn(page: Page, editable: boolean) {
  const head = page.getByRole("columnheader", { name: /fee %/i });
  await expect(head).toBeVisible();
  expect(await head.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(0);
  const over = await page.getByTestId("fee-schedule").evaluate((root) =>
    [...root.querySelectorAll("input")].filter((input) => {
      const cell = input.closest("td");
      if (!cell) return true;
      return input.getBoundingClientRect().width > cell.getBoundingClientRect().width + 1;
    }).length);
  expect(over).toBe(0);
  const inputs = page.getByTestId("fee-schedule").locator("input");
  if (editable) {
    const mins = page.getByTestId("fee-schedule").locator("input[inputmode='decimal']");
    const count = await mins.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) await expect(mins.nth(i)).toHaveValue(/\d+\.\d{2}/);
  } else {
    await expect(inputs).toHaveCount(0);
    await expect(page.getByTestId("fee-schedule-lock")).toBeVisible();
  }
}

async function atPhones(page: Page, editable: boolean) {
  for (const width of PHONE) {
    await page.setViewportSize({ width, height: 800 });
    await feeColumn(page, editable);
  }
}

test("the owner keeps Fee % inside the card", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "j.masri");
  await openFees(page);
  await expect(page.getByRole("columnheader", { name: /\$2,000\.00/ })).toBeVisible();
  await atPhones(page, true);
});

test("a manager keeps Fee % inside the card", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "r.haddad");
  await openFees(page);
  await atPhones(page, true);
});

test("a teller sees the lock and no fields", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "m.costa");
  await openFees(page);
  await atPhones(page, false);
});

test("a refused cashier sees the lock before any save", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "m.costa");
  await openFees(page);
  await expect(page.getByTestId("fee-schedule-save")).toHaveCount(0);
  await atPhones(page, false);
});

test("an auditor sees the lock and no fields", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "j.masri");
  const patched = await page.evaluate(async () => {
    const r = await fetch("/api/staff/a.singh", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ role: "auditor" }),
    });
    return r.status;
  });
  expect(patched).toBe(200);
  try {
    await signInAtDesk(page, "a.singh");
    await openFees(page);
    await atPhones(page, false);
  } finally {
    await signInAtDesk(page, "j.masri");
    await page.evaluate(async () => {
      await fetch("/api/staff/a.singh", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ role: "supervisor" }),
      });
    });
  }
});

test("a conflict keeps Fee % and a 44px Reload", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "j.masri");
  await openFees(page);
  const min = page.getByTestId("fee-schedule").locator("input[inputmode='decimal']").first();
  await min.fill("4.50");
  await min.blur();
  await page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());
  await expect(page.getByTestId("fee-schedule-saved")).toBeVisible();
  const bumped = await page.evaluate(async () => {
    const got = await fetch("/api/tenant/state", { credentials: "same-origin" });
    const body = await got.json();
    const put = await fetch("/api/tenant/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ state: body.state, version: body.version }),
    });
    return put.status;
  });
  expect(bumped).toBe(200);
  await page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());
  await expect(page.getByTestId("fee-schedule-conflict")).toBeVisible();
  for (const width of PHONE) {
    await page.setViewportSize({ width, height: 800 });
    await feeColumn(page, true);
    const h = await page.getByTestId("fee-schedule-reload").evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(44);
  }
});
