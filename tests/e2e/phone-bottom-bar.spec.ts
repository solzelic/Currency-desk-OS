/* Phone bottom bar. At 390×844 the desk uses the bar. At 1280 the
   desktop chrome is the one a wide window already had. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

const PHONE = { width: 390, height: 844 };

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

async function atDesk(page: Page, staffId = "a.singh"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, staffId);
  await dismissTour(page);
  await settled(page);
}

async function moreLabels(page: Page): Promise<string[]> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator("#phone-more")).toBeVisible();
  return page.locator("#phone-more .phone-more-name").allTextContents();
}

test("the bar shows on a phone and is hidden on the desktop", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  await expect(page.locator("#phonebar")).toBeVisible();
  await expect(page.locator("#phone-fab")).toBeVisible();
  await expect(page.locator(".phone-head")).toBeVisible();
  await expect(page.locator(".phone-shop")).toHaveText("York Currency Exchange");
  await expect(page.locator("#appbar")).toBeHidden();
  await expect(page.locator("#menubar")).toBeHidden();
  for (const label of ["Rates", "Ledger", "Clients", "Till", "More"]) {
    await expect(page.locator("#phonebar").getByRole("button", { name: label })).toBeVisible();
  }
  const labelSize = await page.locator("#phonebar .lbl").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(labelSize).toBeGreaterThanOrEqual(12);
  const tillSize = await page.locator(".phone-till").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(tillSize).toBeGreaterThanOrEqual(12);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("#phonebar")).toBeHidden();
  await expect(page.locator("#phone-dock")).toBeHidden();
  await expect(page.locator(".phone-head")).toBeHidden();
  await expect(page.locator("#appbar")).toBeVisible();
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator("#menubar .mb-brand")).toBeVisible();
});

test("each tab opens that app", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  const tabs: Array<[string, RegExp]> = [
    ["rates", /Rate Board/],
    ["ledger", /^Ledger/],
    ["clients", /Clients/],
    ["till", /Cash Drawer/],
  ];
  for (const [id, title] of tabs) {
    await page.locator(`#phonebar [data-phone-app="${id}"]`).click();
    await dismissTour(page);
    await settled(page);
    await expect(page.locator(".win.show.active .win-title")).toContainText(title);
    await expect(page.locator(`#phonebar [data-phone-app="${id}"]`)).toHaveClass(/is-on/);
  }
});

test("more lists the apps this role can open", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  const labels = await moreLabels(page);
  expect(labels).toEqual([
    "Texts",
    "Transfers",
    "Cheques",
    "Compliance",
    "Reports",
    "Vault",
    "Branches",
    "Audit trail",
    "Calculator",
    "Loan centre",
    "Tagged",
    "Pricing & Rates",
    "Dashboard",
    "AI Assistant",
  ]);
  const body = await page.locator(".phone-more-name").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(body).toBeGreaterThanOrEqual(14);
  const row = await page.locator(".phone-more-row").first().boundingBox();
  expect(row && row.height).toBeGreaterThanOrEqual(44);

  await page.locator('#phone-more [data-phone-app="compliance"]').click();
  await dismissTour(page);
  await settled(page);
  await expect(page.locator(".win.show.active .win-title")).toContainText(/Compliance/);
  await expect(page.locator('#phonebar [data-phone-app="more"]')).toHaveClass(/is-on/);
});

test("a teller only sees the apps a teller can open", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "m.costa");
  const labels = await moreLabels(page);
  expect(labels).toEqual([
    "Texts",
    "Transfers",
    "Cheques",
    "Compliance",
    "Audit trail",
    "Calculator",
    "Loan centre",
    "Tagged",
    "Pricing & Rates",
    "AI Assistant",
  ]);
  for (const hidden of ["Reports", "Vault", "Branches", "Settings", "Dashboard"]) {
    expect(labels, hidden).not.toContain(hidden);
  }
});

test("the plus opens new transaction", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  const opened = await page.evaluate(async () => {
    const probe = await fetch("/api/ledger/till-session", { credentials: "same-origin" });
    if (probe.status === 404) return "no-ledger";
    const body = await probe.json().catch(() => ({}));
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
  if (opened !== "no-ledger") {
    expect(opened, "the till did not open").toBe("open");
    const sync = page.waitForResponse((r) => r.url().includes("/api/ledger/till-session") && r.ok());
    await page.reload();
    await landOnDesktop(page);
    await sync;
    await dismissTour(page);
  }
  await expect(page.locator(".phone-till")).toContainText("Till open");
  await page.locator("#phone-fab").click();
  const deal = page.locator(".fixed.inset-0");
  await expect(deal.getByText("New transaction", { exact: true })).toBeVisible();
  await expect(deal.getByRole("button", { name: "Exchange" })).toBeVisible();
  await expect(deal.getByText("Customer pays in", { exact: true })).toBeVisible();
});

test("the window title bar is hidden on a phone and visible on the desktop", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  for (const id of ["rates", "ledger", "clients", "till"]) {
    await page.locator(`#phonebar [data-phone-app="${id}"]`).click();
    await dismissTour(page);
    await settled(page);
    await expect(page.locator(".win.show.active .win-bar")).toBeHidden();
  }
  await expect(page.getByRole("button", { name: "Cash drawer", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconcile & close", exact: true })).toBeVisible();
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await settled(page);
  await expect(page.locator(".win.show.active .win-bar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Records", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compliance", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".win.show.active .win-bar")).toBeVisible();
  await expect(page.locator(".win.show.active .win-title")).toBeVisible();
  await expect(page.locator(".win.show.active .win-close")).toBeVisible();
  await expect(page.locator(".win.show.active .win-tool")).toBeVisible();
  await expect(page.locator(".win.show.active .win-tile")).toBeVisible();
});

test("the open window sits above the bar", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await dismissTour(page);
  await settled(page);
  const covered = await page.evaluate(() => {
    const dock = document.getElementById("phone-dock");
    const win = document.querySelector(".win.show.active");
    if (!dock || !(win instanceof HTMLElement)) return ["missing chrome"];
    const bar = dock.getBoundingClientRect();
    const box = win.getBoundingClientRect();
    const hits: string[] = [];
    if (box.bottom > bar.top + 1) hits.push(`window bottom ${Math.round(box.bottom)} meets the bar at ${Math.round(bar.top)}`);
    const targets = "#phonebar .phone-tab, #phone-fab, .phone-head .mb-acct";
    for (const el of document.querySelectorAll(targets)) {
      if (!(el instanceof HTMLElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) hits.push(`small target ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return hits;
  });
  expect(covered).toEqual([]);
});
