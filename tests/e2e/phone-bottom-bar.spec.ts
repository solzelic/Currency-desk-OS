/* Phone bottom bar. At 390×844 the desk uses the bar. At 1280 the
   desktop chrome is the one a wide window already had. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

const PHONE = { width: 390, height: 844 };

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  /* isVisible answers this instant. A missing Skip button is false,
     not an error, so there is nothing to catch. A throw is a broken
     page and the check should fail on it. */
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
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
  await expect(page.locator("#phone-fab")).toHaveCount(0);
  await expect(page.locator(".phone-head")).toBeVisible();
  await expect(page.locator(".phone-shop")).toHaveText("York Currency Exchange");
  await expect(page.locator("#appbar")).toBeHidden();
  await expect(page.locator("#menubar")).toBeHidden();
  for (const label of ["Rates", "Ledger", "Clients", "Till", "More"]) {
    await expect(page.locator("#phonebar").getByRole("button", { name: label })).toBeVisible();
  }
  const labelSize = await page.locator("#phonebar .lbl").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(labelSize).toBeGreaterThanOrEqual(12);
  const idle = await page.locator("#phonebar .phone-tab:not(.is-on) .lbl").first().evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, weight: style.fontWeight, size: style.fontSize, line: style.lineHeight };
  });
  expect(idle).toEqual({ color: "rgb(107, 103, 96)", weight: "500", size: "12px", line: "16px" });
  const dock = await page.locator("#phone-dock").evaluate((el) => {
    const style = getComputedStyle(el);
    return { h: style.height, bg: style.backgroundColor, shadow: style.boxShadow, border: style.borderTopColor, borderW: style.borderTopWidth };
  });
  expect(dock.h).toBe("64px");
  expect(dock.bg).toBe("rgb(255, 255, 255)");
  expect(dock.shadow).toBe("none");
  expect(dock.borderW).toBe("1px");
  expect(dock.border).toBe("rgb(226, 223, 216)");
  const mark = await page.locator("#phonebar .phone-tab.is-on").evaluate((el) => {
    const style = getComputedStyle(el, "::after");
    return { top: style.top, width: style.width, height: style.height, radius: style.borderBottomRightRadius };
  });
  expect(mark).toEqual({ top: "0px", width: "32px", height: "3px", radius: "3px" });
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
    "Transfers",
    "Cheques",
    "Vault",
    "Compliance",
    "Tagged deals",
    "Audit trail",
    "Reports",
    "Dashboard",
    "Calculator",
    "Loan calculator",
    "Assistant",
    "Pricing",
    "Apps",
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
    "Transfers",
    "Cheques",
    "Compliance",
    "Tagged deals",
    "Audit trail",
    "Calculator",
    "Loan calculator",
    "Assistant",
    "Pricing",
    "Apps",
  ]);
  for (const hidden of ["Reports", "Vault", "Branches", "Settings", "Dashboard", "Texts"]) {
    expect(labels, hidden).not.toContain(hidden);
  }
});

test("a phone has no floating plus", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  await expect(page.locator("#phone-fab")).toHaveCount(0);
  await page.setViewportSize({ width: 599, height: 800 });
  await expect(page.locator("#phone-fab")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("#menubar")).toBeVisible();
  await page.setViewportSize(PHONE);
  await tillOpen(page);
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await dismissTour(page);
  await settled(page);
  await page.getByRole("button", { name: "New transaction", exact: true }).click();
  const deal = page.locator(".fixed.inset-0");
  await expect(deal.getByText("New transaction", { exact: true })).toBeVisible();
  await expect(deal.getByRole("button", { name: "Exchange" })).toBeVisible();
});

/* The cash drawer is one scrolling column. On first load at least
   three denomination rows sit fully above the count panel. After
   scrolling, every row from $100 down to the coins can sit fully
   above that panel. The + floats over the rows and does not cover
   an input or Save count. */
async function countGeometry(page: Page): Promise<{
  rowCount: number;
  fullyVisible: number;
  panelOpaque: boolean;
  panelOnBar: boolean;
  pad: number;
}> {
  return page.evaluate(() => {
    const screen = document.querySelector(".till-screen");
    const foot = document.querySelector(".till-count-foot");
    const dock = document.getElementById("phone-dock");
    const pad = document.querySelector(".till-scroll-pad");
    const rows = [...document.querySelectorAll(".till-den-row")];
    if (!(screen instanceof HTMLElement) || !(foot instanceof HTMLElement) || !(dock instanceof HTMLElement) || !(pad instanceof HTMLElement)) {
      return { rowCount: rows.length, fullyVisible: -1, panelOpaque: false, panelOnBar: false, pad: -1 };
    }
    const box = (el: Element) => el.getBoundingClientRect();
    const view = box(screen);
    const panel = box(foot);
    const fullyVisible = rows.filter((row) => {
      const r = box(row);
      return r.height > 8
        && r.top >= view.top - 0.5
        && r.bottom <= panel.top + 0.5
        && r.bottom <= view.bottom + 0.5
        && r.left >= view.left - 1
        && r.right <= view.right + 1;
    }).length;
    const bg = getComputedStyle(foot).backgroundColor;
    const opaque = /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(bg);
    return {
      rowCount: rows.length,
      fullyVisible,
      panelOpaque: opaque,
      panelOnBar: Math.abs(box(dock).top - panel.bottom) <= 1,
      pad: Math.round(pad.getBoundingClientRect().height),
    };
  });
}

async function placeEveryRow(page: Page): Promise<{ placed: number; blocked: number }> {
  return page.evaluate(() => {
    const screen = document.querySelector(".till-screen");
    const foot = document.querySelector(".till-count-foot");
    const rows = [...document.querySelectorAll(".till-den-row")];
    if (!(screen instanceof HTMLElement) || !(foot instanceof HTMLElement)) {
      return { placed: -1, blocked: rows.length };
    }
    const box = (el: Element) => el.getBoundingClientRect();
    let placed = 0;
    let blocked = 0;
    for (const row of rows) {
      const before = box(row);
      const view = box(screen);
      screen.scrollTop += before.top - view.top - 4;
      const r = box(row);
      const panel = box(foot);
      const port = box(screen);
      const clear = r.height > 8
        && r.top >= port.top - 0.5
        && r.bottom <= panel.top + 0.5
        && r.left >= port.left - 1
        && r.right <= port.right + 1;
      if (clear) placed += 1;
      else blocked += 1;
    }
    return { placed, blocked };
  });
}

/* A fresh book has no open session, and that banner takes the
   rows. Counting starts once the till is open, so the first load
   this checks is that screen. */
async function tillOpen(page: Page): Promise<void> {
  const opened = await page.evaluate(async () => {
    const probe = await fetch("/api/ledger/till-session", { credentials: "same-origin" });
    if (probe.status === 404) return "no-ledger";
    const body = await probe.json().catch(() => {
      /* A probe that is not JSON has no session to read. The test
         opens one below. */
      return {};
    });
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
  if (opened === "no-ledger") return;
  expect(opened, "the till did not open").toBe("open");
  const sync = page.waitForResponse((r) => r.url().includes("/api/ledger/till-session") && r.ok());
  await page.reload();
  await landOnDesktop(page);
  await sync;
  await dismissTour(page);
  await settled(page);
}

test("an owner can bring every denomination fully above the count panel", async ({ page }) => {
  for (const size of [{ width: 390, height: 844 }, { width: 360, height: 780 }]) {
    await page.setViewportSize(size);
    await atDesk(page, "j.masri");
    await tillOpen(page);
    await page.locator('#phonebar [data-phone-app="till"]').click();
    await dismissTour(page);
    await settled(page);
    await expect(page.locator(".phone-till")).toContainText("Till open");
    const dot = await page.locator(".phone-till-dot").evaluate((el) => {
      const style = getComputedStyle(el);
      return { w: style.width, h: style.height, bg: style.backgroundColor, shadow: style.boxShadow };
    });
    expect(dot.w).toBe("8px");
    expect(dot.h).toBe("8px");
    expect(dot.bg).toBe("rgb(21, 122, 62)");
    expect(dot.shadow).toContain("2px");
    await expect(page.locator(".till-den-row")).toHaveCount(10);
    const first = await countGeometry(page);
    expect(first.rowCount, `${size.width} rows`).toBe(10);
    expect(first.fullyVisible, `${size.width} first load`).toBeGreaterThanOrEqual(3);
    expect(first.panelOpaque, `${size.width} panel`).toBe(true);
    expect(first.panelOnBar, `${size.width} panel on the bar`).toBe(true);
    expect(first.pad, `${size.width} scroll pad`).toBeGreaterThanOrEqual(16);
    const scrolled = await placeEveryRow(page);
    expect(scrolled.placed, `${size.width} scrolled into view`).toBe(10);
    expect(scrolled.blocked, `${size.width} blocked`).toBe(0);
  }
  await expect(page.locator("#phone-fab")).toHaveCount(0);
});

/* Desktop window chrome. A phone draws none of it: no traffic
   lights, title bar, title dot, top icon menu, logo and store
   row, or resize grip. The till's own open mark stays. */
const PHONE_CHROME = [
  "#menubar",
  "#tenantbar",
  "#appbar",
  ".edge-rail",
  ".desk-watermark",
  ".phone-appdot",
  ".win.show.active .win-bar",
  ".win.show.active .win-lights",
  ".win.show.active .win-dot",
  ".win.show.active .win-resize",
  ".win.show.active .win-rz",
  ".win-tile-menu",
  ".tenant-logo",
  ".tenant-logo-hint",
];

async function expectNoDesktopChrome(page: Page): Promise<void> {
  for (const sel of PHONE_CHROME) {
    const n = await page.locator(sel).count();
    for (let i = 0; i < n; i++) await expect(page.locator(sel).nth(i), sel).toBeHidden();
  }
  await expect(page.locator(".phone-till-dot")).toBeVisible();
  await expect(page.locator("#phone-fab")).toHaveCount(0);
  await expect(page.locator(".phone-head .mb-acct")).toBeVisible();
  await expect(page.getByText("Your logo", { exact: true })).toBeHidden();
}

test("the window title bar is hidden on a phone and visible on the desktop", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  for (const id of ["rates", "ledger", "clients", "till"]) {
    await page.locator(`#phonebar [data-phone-app="${id}"]`).click();
    await dismissTour(page);
    await settled(page);
    await expectNoDesktopChrome(page);
  }
  await expect(page.getByRole("button", { name: "Cash drawer", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconcile & close", exact: true })).toBeVisible();
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await settled(page);
  await expectNoDesktopChrome(page);
  await expect(page.getByRole("button", { name: "Records", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compliance", exact: true })).toBeVisible();

  const sheet = page.locator("#phone-more");
  if (!(await sheet.isVisible())) {
    await page.locator('#phonebar [data-phone-app="more"]').click();
  }
  await expectNoDesktopChrome(page);
  await page.locator('#phone-more [data-phone-app="vault"]').click();
  await dismissTour(page);
  await settled(page);
  await expectNoDesktopChrome(page);
  if (!(await sheet.isVisible())) {
    await page.locator('#phonebar [data-phone-app="more"]').click();
  }
  await page.locator('#phone-more [data-phone-app="compliance"]').click();
  await dismissTour(page);
  await settled(page);
  await expectNoDesktopChrome(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".win.show.active .win-bar")).toBeVisible();
  await expect(page.locator(".win.show.active .win-title")).toBeVisible();
  await expect(page.locator(".win.show.active .win-dot")).toBeVisible();
  await expect(page.locator(".win.show.active .win-close")).toBeVisible();
  await expect(page.locator(".win.show.active .win-tool")).toBeVisible();
  await expect(page.locator(".win.show.active .win-tile")).toBeVisible();
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator("#tenantbar")).toBeVisible();
  await expect(page.locator(".tenant-logo-hint")).toBeVisible();
  await expect(page.locator(".tenant-logo-hint")).toHaveText("Your logo");
  await expect(page.locator("#appbar")).toBeVisible();
  await expect(page.locator(".edge-rail")).toBeVisible();
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
    const body = win.querySelector(".win-body");
    const pad = body instanceof HTMLElement ? parseFloat(getComputedStyle(body).paddingBottom) : 0;
    if (pad + 0.5 < bar.height + 16) hits.push(`padding ${Math.round(pad)} is under the bar ${Math.round(bar.height)} plus 16`);
    const targets = "#phonebar .phone-tab, .phone-head .mb-acct";
    for (const el of document.querySelectorAll(targets)) {
      if (!(el instanceof HTMLElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) hits.push(`small target ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return hits;
  });
  expect(covered).toEqual([]);
});

/* The dock stores each app's accent as --c. On a phone that colour
   paints the selected tab and the open in-app folder tab when the
   app has one. The window-title dot stays hidden. */
test("the selected tab takes that app's colour", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);

  const painted = (id: string, accentId: string) => page.evaluate(({ id, accentId }) => {
    const tab = document.querySelector(`#phonebar [data-phone-app="${id}"]`);
    const dock = document.querySelector(`#appbar [data-app="${accentId}"]`);
    const win = document.querySelector(".win.show.active");
    if (!(tab instanceof HTMLElement) || !(dock instanceof HTMLElement) || !(win instanceof HTMLElement)) return { missing: true };
    const variable = getComputedStyle(dock).getPropertyValue("--c").trim() || dock.style.getPropertyValue("--c").trim();
    const probe = document.createElement("span");
    probe.style.color = variable;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const labelEl = tab.querySelector(".lbl");
    const iconEl = tab.querySelector("svg");
    if (!(labelEl instanceof Element) || !(iconEl instanceof Element)) return { missing: true };
    const label = getComputedStyle(labelEl).color;
    const icon = getComputedStyle(iconEl).stroke;
    const line = getComputedStyle(tab, "::after").backgroundColor;
    const folder = win.querySelector(".fld-tab.on");
    const bar = win.querySelector(".fld-bar");
    return {
      on: tab.classList.contains("is-on"),
      expected,
      label,
      icon,
      line,
      tabBg: folder ? getComputedStyle(folder).backgroundColor : null,
      barLine: bar ? getComputedStyle(bar).borderBottomColor : null,
    };
  }, { id, accentId });

  let previous = "";
  for (const id of ["rates", "ledger", "clients", "till"]) {
    await page.locator(`#phonebar [data-phone-app="${id}"]`).click();
    await dismissTour(page);
    await settled(page);
    const colour = await painted(id, id);
    expect(colour.on, id).toBe(true);
    expect(colour.label, id).toBe(colour.expected);
    expect(colour.icon, id).toBe(colour.expected);
    expect(colour.line, id).toBe(colour.expected);
    await expect(page.locator(".phone-appdot"), id).toBeHidden();
    if (colour.tabBg != null) {
      expect(colour.tabBg, id).toBe(colour.expected);
      expect(colour.barLine, id).toBe(colour.expected);
    }
    if (previous) expect(colour.expected, id).not.toBe(previous);
    previous = colour.expected || "";
  }

  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="compliance"]').click();
  await dismissTour(page);
  await settled(page);
  const opened = await painted("more", "compliance");
  expect(opened.on).toBe(true);
  expect(opened.label).toBe(opened.expected);
  expect(opened.icon).toBe(opened.expected);
  expect(opened.line).toBe(opened.expected);
  await expect(page.locator(".phone-appdot")).toBeHidden();
  expect(opened.tabBg).toBe(opened.expected);
  expect(opened.barLine).toBe(opened.expected);
  expect(opened.expected).not.toBe(previous);
});
