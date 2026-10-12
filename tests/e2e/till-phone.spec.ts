/* Phone cash drawer. At 360 and 390 the count is one column: chips,
   denomination fields with no spinner, a footer on the bar, and the
   till switch as a bottom sheet. Reconcile is a list. At 1280 the
   drawer is the desktop drawer. Save count posts once when tapped twice. */
import fs from "fs";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = "/opt/cursor/artifacts/pr116";
const SWEEP = [".till-phone", ".phone-head", "#phone-dock"];

const PHONE = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
] as const;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
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

async function openPhoneTill(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="till"]').click();
  await dismissTour(page);
  await settled(page);
  await expect(page.locator(".till-phone")).toBeVisible();
}

async function tillOpen(page: Page): Promise<void> {
  const opened = await page.evaluate(async () => {
    const seeded = await fetch("/api/ledger/opening-balances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ balances: { CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" } }),
    });
    if (seeded.status !== 201 && seeded.status !== 409) return `balances ${seeded.status}`;
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
    return `${res.status}`;
  });
  expect(opened, "the till did not open").toBe("open");
  const sync = page.waitForResponse((r) => r.url().includes("/api/ledger/till-session") && r.ok());
  await page.reload();
  await landOnDesktop(page);
  await sync;
  await dismissTour(page);
  await settled(page);
}

test("a phone shows the count, with no spinner and no plus", async ({ page }) => {
  test.setTimeout(120_000);
  for (const size of PHONE) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await atDesk(page);
    if (hasLedger) await tillOpen(page);
    await openPhoneTill(page);
    await expect(page.locator("#phone-fab")).toHaveCount(0);
    await expect(page.locator(".till-phone")).not.toContainText("New transaction");
    const countNotes = page.getByRole("button", { name: "Count notes" });
    if (await countNotes.isVisible()) await countNotes.click();
    await expect(page.locator(".till-den-qty").first()).toBeVisible();
    /* A row in the DOM above the window, or clipped by the scrollport,
       is not on screen. Measure the scroll viewport and the footer. */
    const rows = await page.locator(".till-phone .till-den-row").evaluateAll((els) => {
      const screen = document.querySelector(".till-phone .phone-scroll");
      const foot = document.querySelector(".till-phone .till-count-foot");
      if (!(screen instanceof HTMLElement) || !(foot instanceof HTMLElement)) return -1;
      const view = screen.getBoundingClientRect();
      const panel = foot.getBoundingClientRect();
      return els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 8
          && r.top >= view.top - 0.5
          && r.bottom <= panel.top + 0.5
          && r.bottom <= view.bottom + 0.5
          && r.left >= view.left - 1
          && r.right <= view.right + 1;
      }).length;
    });
    expect(rows, size.width + " rows inside the count viewport").toBeGreaterThanOrEqual(3);
    const fields = await page.locator(".till-den-qty").evaluateAll((els) => els.map((el) => {
      const style = getComputedStyle(el);
      const input = el as HTMLInputElement;
      return {
        type: el.getAttribute("type"),
        mode: el.getAttribute("inputmode"),
        align: style.textAlign,
        appearance: style.appearance,
        value: input.value,
        border: style.borderTopWidth + " " + style.borderTopStyle,
        radius: style.borderTopLeftRadius,
      };
    }));
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f.type === "text")).toBe(true);
    expect(fields.every((f) => f.mode === "numeric")).toBe(true);
    expect(fields.every((f) => f.align === "center")).toBe(true);
    expect(fields.every((f) => f.appearance === "textfield" || f.appearance === "none")).toBe(true);
    expect(fields.every((f) => f.value === "0")).toBe(true);
    expect(fields.every((f) => f.border === "1px solid")).toBe(true);
    expect(fields.every((f) => parseFloat(f.radius) >= 8)).toBe(true);
    await expect(page.locator(".till-phone").getByRole("spinbutton")).toHaveCount(0);
    const overlap = await page.locator(".till-phone .till-den-row").evaluateAll((rows) => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const hit = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
        a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
      const problems: string[] = [];
      rows.forEach((row, i) => {
        const minus = row.querySelectorAll(".till-step")[0];
        const plus = row.querySelectorAll(".till-step")[1];
        const parts = [row.querySelector(".till-den-face"), minus, row.querySelector(".till-den-qty"), plus, row.querySelector(".till-den-sub")];
        if (parts.some((part) => !part)) {
          problems.push("missing " + i);
          return;
        }
        const boxes = parts.map((part) => box(part as Element));
        for (let a = 0; a < boxes.length; a++) {
          for (let b = a + 1; b < boxes.length; b++) {
            if (hit(boxes[a], boxes[b])) problems.push("overlap " + i + " " + a + " " + b);
          }
        }
        if (Math.abs(boxes[1].width - 44) > 1 || Math.abs(boxes[1].height - 44) > 1) problems.push("minus " + i);
        if (Math.abs(boxes[3].width - 44) > 1 || Math.abs(boxes[3].height - 44) > 1) problems.push("plus " + i);
        const sub = parts[4] as Element;
        const qty = parts[2] as HTMLInputElement;
        if (!/0\.00 [A-Z]{3}/.test(sub.textContent || "")) problems.push("subtotal " + (sub.textContent || ""));
        if ((sub.textContent || "").includes("—")) problems.push("dash");
        if (getComputedStyle(qty).boxShadow !== "none") problems.push("shadow");
        if (qty.value !== "0") problems.push("blank " + qty.value);
        const step = getComputedStyle(minus as Element);
        if (step.borderTopWidth !== "1px" || step.borderRightWidth !== "1px") problems.push("step border");
        if (parseFloat(step.borderTopLeftRadius) < 8) problems.push("step radius");
      });
      if (rows.length > 1) {
        const lefts = rows.map((row) => {
          const face = row.querySelector(".till-den-face");
          const minus = row.querySelectorAll(".till-step")[0];
          const qty = row.querySelector(".till-den-qty");
          const plus = row.querySelectorAll(".till-step")[1];
          const sub = row.querySelector(".till-den-sub");
          return [face, minus, qty, plus, sub].map((el) => Math.round((el as Element).getBoundingClientRect().left));
        });
        for (let c = 0; c < 5; c++) {
          const xs = lefts.map((row) => row[c]);
          if (Math.max(...xs) - Math.min(...xs) > 1) problems.push("column " + c);
        }
      }
      for (let i = 0; i < rows.length - 1; i++) {
        if (hit(box(rows[i]), box(rows[i + 1]))) problems.push("rows " + i);
      }
      return problems;
    });
    expect(overlap, size.width + " denomination rows").toEqual([]);
    const summed = await page.evaluate(() => {
      const read = (text: string | null) => {
        const match = String(text || "").replace(/,/g, "").replace("\u2212", "-").match(/(-?\d+(?:\.\d+)?)\s+[A-Z]{3}/);
        return match ? Number(match[1]) : null;
      };
      const subs = Array.from(document.querySelectorAll(".till-phone .till-den-sub")).map((el) => read(el.textContent));
      const total = read((document.querySelector(".till-phone-counted") || {}).textContent || "");
      if (subs.some((n) => n == null) || total == null) return { ok: false, total, subs };
      const sum = Math.round(subs.reduce((s, n) => s + (n || 0), 0) * 100) / 100;
      return { ok: Math.abs(sum - total) < 0.001, total, sum };
    });
    expect(summed.ok, size.width + " total " + summed.total + " sum " + summed.sum).toBe(true);
    const chips = await page.locator(".till-phone .phone-chips").evaluate((el) => {
      const style = getComputedStyle(el);
      const row = el.getBoundingClientRect();
      const first = el.querySelector(".phone-chip");
      const firstBox = first ? first.getBoundingClientRect() : null;
      const painted = style.maskImage && style.maskImage !== "none"
        ? style.maskImage
        : (style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage || "";
      return {
        mask: painted,
        left: row.left,
        right: row.right,
        width: window.innerWidth,
        first: firstBox ? firstBox.left : null,
      };
    });
    expect(chips.mask).toContain("gradient");
    expect(chips.left).toBeLessThanOrEqual(1);
    expect(Math.abs(chips.right - chips.width)).toBeLessThanOrEqual(1);
    expect(chips.first).toBeGreaterThanOrEqual(15);
    expect(chips.first).toBeLessThanOrEqual(18);
    await page.getByRole("button", { name: "Enter total instead" }).click();
    await expect(page.locator(".till-foot-sum")).toContainText("Entered total");
    await expect(page.locator(".till-den-row")).toHaveCount(0);
    await page.getByRole("button", { name: "Count notes" }).click();
    await expect(page.locator(".till-den-qty").first()).toBeVisible();
    /* A teller on a blind count does not see the whole-drawer total. */
    await expect(page.locator(".till-phone-amount")).toHaveCount(0);
    await expect(page.locator(".till-phone")).not.toContainText("Drawer value");
    await expect(page.locator("[data-till-blind]")).toHaveCount(1);
    const tillButton = page.locator(".till-phone-till");
    if (await tillButton.count()) {
      await expect(tillButton).toHaveText("Till 1");
      await expect(tillButton).not.toContainText("till-01");
    }
    const moves = await page.getByRole("button", { name: "Move cash" }).boundingBox();
    const vault = await page.getByRole("button", { name: "Vault" }).boundingBox();
    expect(moves && vault && Math.abs(moves.width - vault.width)).toBeLessThanOrEqual(1);
    const dock = await page.locator("#phone-dock").boundingBox();
    const foot = await page.locator(".till-count-foot").boundingBox();
    expect(dock && foot && Math.abs(dock.y - (foot.y + foot.height))).toBeLessThanOrEqual(1);
    await expect(page.locator(".till-phone")).not.toContainText("$");
  }
});

test("the difference is in words, and a double tap saves once", async ({ page }) => {
  test.skip(!hasLedger, "needs the ledger");
  test.setTimeout(120_000);
  for (const size of PHONE) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await atDesk(page);
    await tillOpen(page);
    await openPhoneTill(page);
    const notes = page.getByRole("button", { name: "Count notes" });
    if (await notes.isVisible()) await notes.click();
    const field = page.locator(".till-den-qty").first();
    await field.evaluate((el) => {
      const screen = el.closest(".till-screen");
      const foot = document.querySelector(".till-count-foot");
      if (!(screen instanceof HTMLElement) || !foot) return;
      const limit = foot.getBoundingClientRect().top;
      const r = el.getBoundingClientRect();
      if (r.bottom > limit - 8) screen.scrollTop += r.bottom - limit + 16;
    });
    await field.fill("1");
    await expect(page.locator(".till-phone .phone-sticky-btn")).toBeEnabled();
    const accent = await page.locator(".till-phone .phone-sticky-btn").evaluate((btn) => {
      const root = btn.closest("[data-app='till']") || document.body;
      const probe = document.createElement("span");
      probe.style.background = "var(--brand-primary)";
      root.appendChild(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { bg: getComputedStyle(btn).backgroundColor, expected };
    });
    expect(accent.bg).toBe(accent.expected);
    const show = page.getByRole("button", { name: "Show expected amount" });
    if (await show.isVisible()) await show.click();
    await expect(page.locator(".till-diff").first()).toHaveText(/(over|short|Matches the book)/);
    await expect(page.locator(".till-phone-counted")).toContainText(/\d\.\d{2} [A-Z]{3}/);
    if (size.width !== 390) continue;
    let posts = 0;
    const countPosts = (req: { method: () => string; url: () => string }) => {
      if (req.method() === "POST" && req.url().includes("/api/ledger/till-counts")) posts += 1;
    };
    page.on("request", countPosts);
    await page.locator(".till-phone .phone-sticky-btn").evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });
    await expect.poll(() => posts, { timeout: 10_000 }).toBe(1);
    page.off("request", countPosts);
  }
});

test("the till switch is a bottom sheet", async ({ page }) => {
  for (const size of PHONE) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await atDesk(page);
    if (hasLedger) await tillOpen(page);
    await openPhoneTill(page);
    await page.locator(".till-phone-till").click();
    const sheet = page.locator(".till-sheet");
    await expect(sheet).toBeVisible();
    const box = await sheet.locator(".till-sheet-panel").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const host = el.closest(".till-sheet");
      return {
        position: host ? getComputedStyle(host).position : "",
        bottom: Math.round(r.bottom),
        height: window.innerHeight,
        top: r.top,
      };
    });
    expect(box.position).toBe("fixed");
    expect(Math.abs(box.bottom - box.height)).toBeLessThanOrEqual(1);
    expect(box.top).toBeGreaterThan(40);
    await page.getByRole("button", { name: "Close till list" }).click();
    await expect(sheet).toBeHidden();
  }
});

test("loading and no open till are honest", async ({ page }) => {
  test.skip(!hasLedger, "needs the ledger");
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await page.route("**/api/ledger/till-balances", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue();
  });
  await page.route("**/api/ledger/till-session", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue();
  });
  await openPhoneTill(page);
  await expect(page.locator(".till-wake")).toContainText("Waking the server", { timeout: 8000 });
  await page.unroute("**/api/ledger/till-balances");
  await page.unroute("**/api/ledger/till-session");

  await page.route("**/api/ledger/till-session", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: null, latestCounts: {} }) });
  });
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await settled(page);
  await openPhoneTill(page);
  await expect(page.locator(".till-phone .phone-empty")).toContainText("This till is not open");
  await expect(page.locator(".till-phone")).not.toContainText("$");
  await expect(page.getByRole("button", { name: "Open the till" })).toBeVisible();
  await phoneSweep(page, { roots: SWEEP });

  await page.unroute("**/api/ledger/till-session");
  await page.route("**/api/ledger/till-balances", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ message: "The till book did not load." }),
  }));
  await page.route("**/api/ledger/till-session", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "The till book did not load." }),
    });
  });
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await settled(page);
  await openPhoneTill(page);
  await expect(page.locator(".till-phone .phone-error")).toContainText("The till book did not load.");
  await expect(page.locator(".till-den-row")).toHaveCount(0);
  await phoneSweep(page, { roots: SWEEP });
  await page.unroute("**/api/ledger/till-balances");
  await page.unroute("**/api/ledger/till-session");
});

async function shotBoth(page: Page, name: string, prepare?: () => Promise<void>): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const size of PHONE) {
    await page.setViewportSize({ width: size.width, height: size.height });
    if (prepare) await prepare();
    await page.screenshot({ path: `${SHOTS}/${name}_${size.width}.png` });
  }
}

async function scrollIntoPhoneView(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const screen = document.querySelector(".till-phone .phone-scroll");
    const el = document.querySelector(sel);
    if (!(screen instanceof HTMLElement) || !el) return;
    const view = screen.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    screen.scrollTop += r.top - view.top - 8;
  }, selector);
}

test("count, coins, the till sheet, reconcile, and hand off pass the phone sweep", async ({ page }) => {
  test.skip(!hasLedger, "needs the ledger");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await tillOpen(page);
  await openPhoneTill(page);
  const countNotes = page.getByRole("button", { name: "Count notes" });
  if (await countNotes.isVisible()) await countNotes.click();
  await expect(page.locator(".till-den-qty").first()).toBeVisible();

  await shotBoth(page, "count");
  await phoneSweep(page, { roots: SWEEP });

  await shotBoth(page, "coins", async () => {
    await scrollIntoPhoneView(page, ".till-phone-group");
  });
  const coinInView = await page.locator("[data-till-coin]").first().evaluate((el) => {
    const screen = document.querySelector(".till-phone .phone-scroll");
    const foot = document.querySelector(".till-phone .till-count-foot");
    if (!(screen instanceof HTMLElement) || !(foot instanceof HTMLElement)) return false;
    const view = screen.getBoundingClientRect();
    const panel = foot.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.height > 8 && r.top >= view.top - 0.5 && r.bottom <= panel.top + 0.5 && r.bottom <= view.bottom + 0.5;
  });
  expect(coinInView, "a coin row inside the viewport").toBe(true);
  await phoneSweep(page, { roots: SWEEP });

  await shotBoth(page, "focus", async () => {
    await scrollIntoPhoneView(page, ".till-den-qty");
    await page.locator(".till-den-qty").first().focus();
  });

  await page.locator(".till-phone-till").click();
  await expect(page.locator(".till-sheet")).toBeVisible();
  await shotBoth(page, "switch");
  await phoneSweep(page, { roots: [".till-sheet"] });
  await page.getByRole("button", { name: "Close till list" }).click();

  await page.locator(".till-den-qty").first().fill("1");
  await page.locator(".till-phone .phone-sticky-btn").click();
  await expect(page.locator(".till-phone").getByRole("button", { name: "Saved" })).toBeVisible({ timeout: 15_000 });
  await shotBoth(page, "saved");

  await page.getByRole("tab", { name: "Reconcile and close" }).click();
  const cad = page.locator(".till-recon-row", { hasText: "CAD" }).first();
  await expect(cad).toContainText(/Expected /);
  await expect(cad).toContainText(/Counted [\d,]+(\.\d+)? CAD|Not counted yet/);
  await expect(cad).toContainText(/Matches the book|CAD over|CAD short|Not counted yet/);
  await expect(page.locator(".till-phone .phone-sticky-btn")).toHaveText("Close the till");
  await expect(page.locator(".till-phone")).not.toContainText("$");
  await shotBoth(page, "reconcile");
  await phoneSweep(page, { roots: SWEEP });

  await page.getByRole("tab", { name: "Count" }).click();
  await page.getByRole("button", { name: "Hand off" }).click();
  await expect(page.getByRole("heading", { name: "Open this on a computer" })).toBeVisible();
  await expect(page.getByText("Hand off the drawer")).toHaveCount(0);
  await expect(page.getByText("local note")).toBeVisible();
  await shotBoth(page, "handoff");
  await phoneSweep(page, { roots: SWEEP });
});

test("a short till does not close until the sheet is confirmed", async ({ page }) => {
  test.skip(!hasLedger, "needs the ledger");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await tillOpen(page);
  await openPhoneTill(page);
  const balances: Record<string, string> = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/till-balances", { credentials: "same-origin" });
    if (!res.ok) return {};
    const body = await res.json();
    return (body && body.balances) || {};
  });
  const currencies = Object.keys(balances);
  expect(currencies.length).toBeGreaterThan(0);
  for (const ccy of currencies) {
    await page.locator(".till-phone").getByRole("tab", { name: new RegExp("^" + ccy + "\\b") }).first().click();
    const enter = page.getByRole("button", { name: "Enter total instead" });
    if (await enter.isVisible()) await enter.click();
    const figure = ccy === "CAD" ? "1.00" : String(Math.max(Number(balances[ccy]) || 0, 0.01));
    await page.locator(".till-phone").getByRole("textbox", { name: ccy + " total" }).fill(figure);
  }
  await page.getByRole("tab", { name: "Reconcile and close" }).click();
  const sticky = page.locator(".till-phone .phone-sticky-btn", { hasText: "Close the till" });
  await expect(sticky).toBeEnabled();
  let posts = 0;
  const onClose = (req: { method: () => string; url: () => string }) => {
    if (req.method() === "POST" && req.url().includes("/close")) posts += 1;
  };
  page.on("request", onClose);
  await sticky.click();
  const sheet = page.locator(".till-sheet").last();
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(/CAD short/);
  expect(posts).toBe(0);
  const confirm = page.locator(".till-sheet .till-save");
  const confirmAccent = await confirm.evaluate((btn) => {
    const root = btn.closest("[data-app='till']") || document.body;
    const probe = document.createElement("span");
    probe.style.background = "var(--brand-primary)";
    root.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { bg: getComputedStyle(btn).backgroundColor, expected };
  });
  expect(confirmAccent.bg).toBe(confirmAccent.expected);
  try {
    await confirm.click({ timeout: 3_000 });
  } catch {
    await confirm.evaluate((el: HTMLButtonElement) => el.click());
  }
  await expect.poll(() => posts, { timeout: 10_000 }).toBe(1);
  page.off("request", onClose);
});

test("desktop till is the desktop till at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await page.locator('#appbar [data-app="till"]').click();
  await dismissTour(page);
  await settled(page);
  await expect(page.locator(".till-phone")).toHaveCount(0);
  await expect(page.locator(".till-sheet")).toHaveCount(0);
  await expect(page.locator("#phonebar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Cash drawer" }).first()).toBeVisible();
  /* A saved count comes back as a total, which is the desktop drawer.
     Denomination steppers, when they are on screen, stay 26×28. */
  const steps = page.locator(".till-step");
  if (await steps.count()) {
    const step = await steps.first().boundingBox();
    expect(step && Math.round(step.width)).toBe(26);
    expect(step && Math.round(step.height)).toBe(28);
  }
  await expect(page.locator(".till-screen input[type='number']").first()).toBeVisible();
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/desktop_1280.png` });
});
