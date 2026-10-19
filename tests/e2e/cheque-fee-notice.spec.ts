import { createRequire } from "node:module";
import path from "node:path";
/* The fee notice is a sentence with the lock in the first line.
   On a 360px phone that line has to wrap. A row that runs off the
   screen is the notice cut off, which is what this check refuses. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

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
    const mins = page.getByTestId("fee-min");
    const count = await mins.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) await expect(mins.nth(i)).toHaveValue(/\d+\.\d{2}/);
    const riskH = await page.getByTestId("fee-schedule").locator("select").first().evaluate((el) => el.getBoundingClientRect().height);
    expect(riskH).toBeGreaterThanOrEqual(44);
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
  await page.setViewportSize({ width: 1280, height: 1000 });
  expect(await page.getByTestId("fee-schedule").locator("select").first().evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});

test("a manager keeps Fee % inside the card", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "r.haddad");
  await openFees(page);
  await atPhones(page, true);
  await page.setViewportSize({ width: 1280, height: 1000 });
  expect(await page.getByTestId("fee-schedule").locator("select").first().evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
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
  const min = page.getByTestId("fee-min").first();
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
  await min.fill("9.99");
  await min.blur();
  await page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());
  await expect(page.getByTestId("fee-schedule-conflict")).toBeVisible();
  await expect(min).toHaveValue("9.99");
  const tone = await page.getByTestId("fee-schedule-conflict").evaluate((el) => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const L = (rgb: string) => {
      const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
      return 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
    };
    const banner = getComputedStyle(el);
    const reload = getComputedStyle(el.querySelector("button")!);
    const pair = (fg: string) => (Math.max(L(fg), L(banner.backgroundColor)) + 0.05) / (Math.min(L(fg), L(banner.backgroundColor)) + 0.05);
    return { text: pair(banner.color), reload: pair(reload.color) };
  });
  expect(tone.text).toBeGreaterThanOrEqual(4.5);
  expect(tone.reload).toBeGreaterThanOrEqual(4.5);
  for (const width of PHONE) {
    await page.setViewportSize({ width, height: 780 });
    await feeColumn(page, true);
    await expect(min).toHaveValue("9.99");
    await page.evaluate(() => {
      document.querySelectorAll(".win-body, .fee-schedule-card").forEach((el) => { (el as HTMLElement).scrollTop = 0; (el as HTMLElement).scrollLeft = 0; });
      window.scrollTo(0, 0);
    });
    const place = await page.getByTestId("fee-schedule-conflict").evaluate((el) => {
      const banner = el.getBoundingClientRect();
      const reload = el.querySelector("button")!.getBoundingClientRect();
      const dock = document.querySelector("#phone-dock");
      const dockTop = dock && getComputedStyle(dock).display !== "none" ? dock.getBoundingClientRect().top : window.innerHeight;
      return { position: getComputedStyle(el).position, top: banner.top, bottom: banner.bottom, reloadBottom: reload.bottom, reloadH: reload.height, dockTop, viewH: window.innerHeight, viewW: window.innerWidth, right: banner.right };
    });
    expect(place.position).toBe("fixed");
    expect(place.reloadH).toBeGreaterThanOrEqual(44);
    expect(place.top).toBeGreaterThanOrEqual(0);
    expect(place.reloadBottom).toBeLessThanOrEqual(place.dockTop + 0.5);
    expect(place.bottom).toBeLessThanOrEqual(place.viewH + 0.5);
    expect(place.right).toBeLessThanOrEqual(place.viewW + 0.5);
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => {
    document.querySelectorAll(".win-body").forEach((el) => { (el as HTMLElement).scrollTop = 0; });
  });
  const desk = await page.getByTestId("fee-schedule-conflict").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { position: getComputedStyle(el).position, top: box.top, bottom: box.bottom, viewH: window.innerHeight };
  });
  expect(desk.position).toBe("fixed");
  expect(desk.top).toBeGreaterThanOrEqual(0);
  expect(desk.bottom).toBeLessThanOrEqual(desk.viewH + 0.5);
  await page.getByTestId("fee-schedule-reload").evaluate((el: HTMLElement) => el.click());
  await expect(page.getByTestId("fee-schedule-conflict")).toHaveCount(0);
  await expect(min).toHaveValue("4.50");
  await page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());
  await expect(page.getByTestId("fee-schedule-saved")).toBeVisible();
});

/* A 500, and a 200 that is not JSON, both have to show the plain error
   line and leave the typed fees alone. Break, then restored: removing
   setTrouble(true) from save()'s catch hid the line and this check failed. */
test("a failed save shows the error line and keeps the typed fee", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signInAtDesk(page, "r.haddad");
  await openFees(page);
  const fee = page.getByTestId("fee-schedule");
  const pct = fee.getByTestId("fee-pct").first();
  const min = fee.getByTestId("fee-min").first();
  const banner = page.getByTestId("fee-schedule-error");
  const save = () => page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());

  await pct.fill("2.5");
  await min.fill("8.25");
  await min.blur();
  await page.route("**/api/tenant/state", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"no\"}" });
  });
  await save();
  await expect(banner).toContainText("That change didn't save. Try again.");
  await expect(pct).toHaveValue("2.5");
  await expect(min).toHaveValue("8.25");
  await page.unroute("**/api/tenant/state");

  await page.reload();
  await landOnDesktop(page);
  await openFees(page);
  await pct.fill("3.5");
  await min.fill("7.10");
  await min.blur();
  await page.route("**/api/tenant/state", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({ status: 200, contentType: "text/plain", body: "nope" });
  });
  await save();
  await expect(banner).toContainText("That change didn't save. Try again.");
  await expect(pct).toHaveValue("3.5");
  await expect(min).toHaveValue("7.10");
});

/* Fee % is text. An empty field stays empty while it is being edited.
   Leaving it empty puts the saved percent back. "2." is not an error. */
test("clearing Fee % can be retyped, and blur restores the saved percent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signInAtDesk(page, "j.masri");
  await openFees(page);
  const pct = page.getByTestId("fee-pct").nth(1);
  await expect(pct).toHaveValue("2");
  await pct.fill("");
  await expect(pct).toHaveValue("");
  await pct.fill("2.25");
  await expect(pct).toHaveValue("2.25");
  await pct.fill("2.");
  await expect(pct).toHaveValue("2.");
  await expect(page.getByTestId("fee-schedule-places")).toHaveCount(0);
  await pct.fill("");
  await pct.blur();
  await expect(pct).toHaveValue("2");
});

test("too many decimals shows the amber line above Save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signInAtDesk(page, "j.masri");
  await openFees(page);
  const detail = "That change didn't save. A fee % can have up to 2 decimals, like 2.25.";
  await page.route("**/api/tenant/state", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "fee_places", field: "feePct", detail }) });
  });
  await page.getByTestId("fee-min").first().fill("4.50");
  await page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());
  const banner = page.getByTestId("fee-schedule-places");
  await expect(banner).toContainText(detail);
  await expect(banner.locator("svg")).toBeVisible();
});

/* York's screen reads the schedule from this browser. The SQL row is
   the stored schedule, planted here because the save API refuses 2.125.
   Load shows 2.13. Editing a different row then saves that 2.13. */
const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ state: Record<string, unknown> }> }>;
    end: () => Promise<void>;
  };
};

test("a stored 2.125 shows as 2.13, and editing another row saves 2.13", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signInAtDesk(page, "j.masri");
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  const found = await pool.query("SELECT state FROM tenant_state WHERE tenant_id=$1", ["tnt-yorkfx"]);
  const state = found.rows[0].state;
  const key = "cdos_cheque_schedule_v1";
  const raw = state[key];
  const rows = typeof raw === "string" ? JSON.parse(raw) as Array<{ id: string; feePct: number }> : raw as Array<{ id: string; feePct: number }>;
  const planted = rows.map((row) => row.id === "payroll" ? { ...row, feePct: 2.125 } : row);
  const next = { ...state, [key]: JSON.stringify(planted) };
  await pool.query("UPDATE tenant_state SET state=$2::jsonb WHERE tenant_id=$1", ["tnt-yorkfx", JSON.stringify(next)]);
  await page.evaluate(({ storageKey, list }) => {
    localStorage.setItem(storageKey, JSON.stringify(list));
  }, { storageKey: key, list: planted });
  try {
    await page.reload();
    await landOnDesktop(page);
    await openFees(page);
    await page.evaluate(async () => {
      const res = await fetch("/api/tenant/state", { credentials: "same-origin" });
      const body = await res.json();
      const persist = window.CDOS_PERSIST;
      if (persist && persist.noteVersion && typeof body.version === "number") persist.noteVersion(body.version);
    });
    const payroll = page.getByTestId("fee-pct").nth(1);
    await expect(payroll).toHaveValue("2.13");
    const min = page.getByTestId("fee-min").first();
    await min.fill("4.50");
    await min.blur();
    await page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("fee-schedule-saved")).toBeVisible();
    const again = await pool.query("SELECT state FROM tenant_state WHERE tenant_id=$1", ["tnt-yorkfx"]);
    const stored = again.rows[0].state[key];
    const list = typeof stored === "string" ? JSON.parse(stored) as Array<{ id: string; feePct: number }> : stored as Array<{ id: string; feePct: number }>;
    expect(String(list.find((row) => row.id === "payroll")!.feePct)).toBe("2.13");
  } finally {
    await pool.query("UPDATE tenant_state SET state=$2::jsonb WHERE tenant_id=$1", ["tnt-yorkfx", JSON.stringify(state)]);
    await pool.end();
  }
});

/* "4." is 4.00. "." is not a percent, so blur puts the saved one back. */
test("a trailing dot tidies on blur", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signInAtDesk(page, "j.masri");
  await openFees(page);
  const min = page.getByTestId("fee-min").nth(1);
  await min.fill("4.");
  await min.blur();
  await expect(min).toHaveValue("4.00");
  const pct = page.getByTestId("fee-pct").nth(1);
  await pct.fill(".");
  await pct.blur();
  await expect(pct).toHaveValue("2");
});

/* The banner prints the server's sentence. Hardcoding the fee % line
   leaves Min and Max showing the wrong words, and this check goes red. */
test("the places banner shows each server message", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signInAtDesk(page, "j.masri");
  await openFees(page);
  const cases = [
    { field: "feePct", testid: "fee-pct", detail: "That change didn't save. A fee % can have up to 2 decimals, like 2.25." },
    { field: "feeMin", testid: "fee-min", detail: "That change didn't save. A minimum fee can have up to 2 decimals, like 4.00." },
    { field: "feeMax", testid: "", detail: "That change didn't save. A maximum fee can have up to 2 decimals, like 4.00." },
  ];
  for (const item of cases) {
    await page.route("**/api/tenant/state", (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "fee_places", field: item.field, id: "government", detail: item.detail }),
      });
    });
    await page.getByTestId("fee-min").first().fill("4.50");
    await page.getByTestId("fee-schedule-save").evaluate((el: HTMLElement) => el.click());
    const banner = page.getByTestId("fee-schedule-places");
    await expect(banner).toHaveText(item.detail);
    await expect(banner).toHaveCSS("font-size", "13px");
    if (item.testid) {
      const input = page.getByTestId(item.testid).first();
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect.poll(() => input.evaluate((el) => getComputedStyle(el).outlineWidth)).not.toBe("0px");
    }
    await page.unroute("**/api/tenant/state");
  }
});
