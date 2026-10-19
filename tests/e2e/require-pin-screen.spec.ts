/* Require PIN off must not rename the desk. The header stays the
   signed-in teller until POST /api/auth/switch succeeds, and that
   call is not made by opening the other person's row. A non-owner
   does not get the PIN switches, and a refused save shows the
   server's sentence. */
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

async function account(page: Page) {
  const button = page.locator(".mb-acct:visible");
  await expect(button).toBeVisible();
  return button;
}

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
}

async function openEmployees(page: Page): Promise<void> {
  const phone = page.locator("#phonebar");
  if (await phone.isVisible()) {
    const sheet = page.locator("#phone-more");
    if (!(await sheet.isVisible())) await page.locator('#phonebar [data-phone-app="more"]').click();
    await page.locator('#phone-more [data-phone-app="settings"]').click();
  } else {
    await page.locator('[data-app="settings"]').click();
  }
  await dismissTour(page);
  const employees = page.getByRole("button", { name: "Employees" });
  await expect(employees).toBeVisible();
  await employees.click();
}

test("a teller does not become the owner when that flag is off", async ({ page }) => {
  const switches: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/auth/switch")) switches.push(req.postData() || "");
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "m.costa");
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}") as {
      pinOnSwitch?: boolean;
      employees?: { code?: string; name?: string; requirePin?: boolean }[];
    };
    raw.pinOnSwitch = false;
    for (const person of raw.employees || []) {
      if (person.code === "j.masri" || person.name === "J. Masri") person.requirePin = false;
    }
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
  });
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);

  const button = await account(page);
  await expect(button).toContainText("M. Costa");
  await button.click();
  const menu = page.locator(".acct-menu:visible");
  await menu.getByRole("button", { name: /J\. Masri/ }).click();
  await expect(page.getByText("Switch account", { exact: true })).toBeVisible();
  await expect(button).toContainText("M. Costa");
  await expect(button).not.toContainText("J. Masri");
  expect(switches).toEqual([]);
  const wrote = await page.evaluate(async () => {
    const cur = await fetch("/api/tenant/state", { credentials: "same-origin" }).then((r) => r.json());
    const saved = await fetch("/api/tenant/state", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: { ...(cur.state || {}), actingUser: "j.masri", actorId: "tnt-yorkfx:j.masri" },
        version: cur.version ?? 0,
        actingUser: "j.masri",
        actorId: "tnt-yorkfx:j.masri",
      }),
    });
    const me = await fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => r.json());
    const back = await fetch("/api/tenant/state", { credentials: "same-origin" }).then((r) => r.json());
    return { status: saved.status, me: me.user && me.user.id, acting: back.state && back.state.actingUser };
  });
  expect(wrote.me).toBe("m.costa");
  expect(wrote.acting).toBeFalsy();
  await expect(button).toContainText("M. Costa");
});

test("a manager sees the owner sentence and not the PIN switches", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAtDesk(page, "r.haddad");
  await openEmployees(page);
  await expect(page.locator('[data-pin-locked="switch"]')).toHaveText("Only the owner can change this.");
  await expect(page.locator('[data-pin-locked="till"]')).toHaveText("Only the owner can change this.");
  await expect(page.locator('[data-pin-locked="void"]')).toHaveText("Only the owner can change this.");
  await expect(page.locator('[data-pin-state="switch"]')).toHaveText("On");
  await expect(page.locator('[data-pin-state="switch"]')).toHaveCSS("color", "rgb(10, 10, 10)");
  await expect(page.locator('[data-pin-state="till"]')).toHaveText("On");
  await expect(page.locator('[data-pin-state="till"]')).toHaveCSS("color", "rgb(10, 10, 10)");
  await expect(page.locator('[data-pin-state="void"]')).toHaveText("On");
  await expect(page.locator('[data-pin-state="void"]')).toHaveCSS("color", "rgb(10, 10, 10)");
  await expect(page.getByText("Only the owner can turn off Require PIN.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Require PIN to switch account" })).toHaveCount(0);
  const ratio = await page.locator('[data-pin-locked="switch"]').evaluate((el) => {
    const parse = (s: string) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lin = (c: number) => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    let node: HTMLElement | null = el;
    let bg = "rgb(255, 255, 255)";
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") { bg = c; break; }
      node = node.parentElement;
    }
    const fg = lum(parse(getComputedStyle(el).color));
    const back = lum(parse(bg));
    return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  const banner = await page.evaluate(async () => {
    const bridge = (window as unknown as { CDOS_PERSIST: { begin: (id: string) => Promise<string>; save: () => Promise<void> } }).CDOS_PERSIST;
    await bridge.begin("tnt-yorkfx");
    const cur = await fetch("/api/tenant/state", { credentials: "same-origin" }).then((r) => r.json()) as { state?: { cdos_settings?: unknown } };
    const stored = cur.state && cur.state.cdos_settings;
    const settings = typeof stored === "string" ? JSON.parse(stored) as { pinOnSwitch?: boolean } : { ...(stored as { pinOnSwitch?: boolean } || {}) };
    settings.pinOnSwitch = false;
    localStorage.setItem("cdos_settings", JSON.stringify(settings));
    await bridge.save();
    return document.getElementById("cdos-persist-banner")?.textContent ?? "";
  });
  expect(banner).toContain("Only the owner can change whether a PIN is needed to switch accounts.");
});

test("a manager does not get a person's Require PIN switch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAtDesk(page, "r.haddad");
  await openEmployees(page);
  await page.getByRole("button", { name: /J\. Masri/ }).click();
  const note = page.locator('[data-pin-locked="require"]');
  const value = page.locator('[data-pin-state="require"]');
  await expect(note).toHaveText("Only the owner can change this.");
  await expect(value).toHaveText("On");
  await expect(page.getByRole("button", { name: "Require PIN for J. Masri" })).toHaveCount(0);
  const colors = await value.evaluate((el) => {
    const noteEl = document.querySelector('[data-pin-locked="require"]');
    return {
      value: getComputedStyle(el).color,
      note: noteEl ? getComputedStyle(noteEl).color : "",
    };
  });
  expect(colors.value).toBe("rgb(10, 10, 10)");
  expect(colors.note).toBe("rgb(107, 107, 107)");
});

test("the owner still has the PIN switches", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "j.masri");
  await openEmployees(page);
  const toggle = page.getByRole("button", { name: "Require PIN to switch account" });
  await expect(toggle).toBeVisible();
  const box = await toggle.boundingBox();
  expect(box && box.width).toBeGreaterThanOrEqual(44);
  expect(box && box.height).toBeGreaterThanOrEqual(44);
});
