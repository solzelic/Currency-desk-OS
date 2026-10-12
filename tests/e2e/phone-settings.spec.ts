/* Phone Settings. 360 and 390 are the phone. 1280 is the desktop
   rail, and the phone list must not paint there. */
import type { Locator, Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { mkdirSync } from "node:fs";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = "/opt/cursor/artifacts/screenshots";

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

async function atDesk(page: Page, staffId: string): Promise<void> {
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

async function openSettings(page: Page): Promise<Locator> {
  const sheet = page.locator("#phone-more");
  if (!(await sheet.isVisible())) {
    await page.locator('#phonebar [data-phone-app="more"]').click();
  }
  await page.locator('#phone-more [data-phone-app="settings"]').click();
  await dismissTour(page);
  await settled(page);
  const root = page.locator("[data-phone-settings]");
  await expect(root).toBeVisible();
  await expect(root.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  return root;
}

/* A known PIN, so the change flow can prove the current one. Reset
   is the existing forgot-it route and the seed password. */
async function knownPin(page: Page): Promise<void> {
  const res = await page.request.post("/api/staff/pin/reset", {
    data: { password: "yorkville", pin: "1357" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function press(page: Page, digits: string): Promise<void> {
  for (const d of digits) {
    await page.locator(".keypad button", { hasText: new RegExp("^" + d + "$") }).click();
  }
}

function shot(name: string): string {
  mkdirSync(SHOTS, { recursive: true });
  return SHOTS + "/" + name;
}

test("settings lists, search, PIN, and sign-out on a phone", async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 780 });
    await atDesk(page, "j.masri");
    await knownPin(page);
    const root = await openSettings(page);
    await expect(root.getByText("PIN and sign-in")).toBeVisible();
    await expect(root.getByText("This shop. Change on a computer")).toBeVisible();
    await expect(root.getByRole("button", { name: /Shop details/ })).toBeVisible();
    await expect(root.getByText("Other apps. Change on a computer")).toBeVisible();
    await expect(root.getByText("Example data")).toHaveCount(0);
    for (const gone of ["Texts", "Receipts", "Billing and plan", "Ticker tape", "Role presets"]) {
      await expect(root.getByText(gone, { exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: shot(`settings_list-owner_${width}.png`) });

    await root.getByRole("button", { name: /Shop details/ }).click();
    await expect(root.getByRole("heading", { name: "Shop details", exact: true })).toBeVisible();
    await expect(root.getByRole("heading", { name: "Change this on a computer" })).toBeVisible();
    await expect(root.getByText("Shop details are edited on a computer so nothing is changed by accident.")).toBeVisible();
    await expect(root.getByText("Use a computer to change this.")).toHaveCount(0);
    await expect(root.getByText("York Currency Exchange")).toBeVisible();
    await expect(root.getByText(/120 Adelaide/)).toBeVisible();
    await expect(root.getByText("Mon to Fri")).toBeVisible();
    await expect(root.getByText("9:30 AM to 6:00 PM")).toBeVisible();
    await expect(root.getByText("Sat, Sun and holidays")).toBeVisible();
    await expect(root.getByText("10:00 AM to 5:00 PM")).toBeVisible();
    await expect(root.locator(".phq-kv")).toBeVisible();
    await expect(root.locator(".phq-kv")).not.toContainText("–");
    const screenFill = await root.locator(".phone-computer").evaluate((el) => {
      const shell = el.getBoundingClientRect();
      const body = el.closest(".win-body");
      const dock = document.getElementById("phone-dock");
      const dockBox = dock ? dock.getBoundingClientRect() : null;
      return {
        reachesBar: dockBox ? shell.bottom >= dockBox.top - 2 : false,
        bg: getComputedStyle(el).backgroundColor,
        bodyBg: body ? getComputedStyle(body).backgroundColor : "",
      };
    });
    expect(screenFill.reachesBar).toBe(true);
    expect(screenFill.bg).toBe("rgb(247, 246, 243)");
    expect(screenFill.bg).toBe(screenFill.bodyBg);
    await expect(page.locator(".sheet")).toHaveCount(0);
    await expect(page.locator(".settings-shell")).toBeHidden();
    await page.screenshot({ path: shot(`settings_computer-section_${width}.png`) });
    await root.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(root.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

    const search = root.getByLabel("Search settings");
    await search.fill("zzzz");
    await expect(root.getByText(/Nothing matches “zzzz”/)).toBeVisible();
    await root.getByRole("button", { name: "Clear" }).click();
    await expect(root.getByText("PIN and sign-in")).toBeVisible();

    await search.fill("billing");
    await root.getByRole("button", { name: /Billing and plan/ }).click();
    await expect(root.getByRole("heading", { name: "Change this on a computer" })).toBeVisible();
    await expect(root.locator(".phq-kv")).toHaveCount(0);
    await root.getByRole("button", { name: "Settings", exact: true }).click();
    await search.fill("texts");
    await expect(root.getByText(/Nothing matches “texts”/)).toBeVisible();
    await search.fill("receipt");
    await expect(root.getByText(/Nothing matches “receipt”/)).toBeVisible();
    await root.getByRole("button", { name: "Clear" }).click();

    await root.getByText("PIN and sign-in").click();
    await expect(root.getByRole("heading", { name: "PIN and sign-in" })).toBeVisible();
    await expect(root.locator(".badge", { hasText: "PIN set" })).toBeVisible();
    await expect(root.getByText("Always on")).toBeVisible();
    await expect(root.getByRole("button", { name: "Change my PIN" })).toBeVisible();
    await expect(root.getByText("A void asks for your PIN. The owner sets this.")).toBeVisible();
    await expect(root.getByRole("switch")).toHaveCount(0);
    await page.screenshot({ path: shot(`settings_pin-detail_${width}.png`) });

    await page.getByRole("button", { name: "Change my PIN" }).click();
    await expect(page.getByText("Enter your current PIN")).toBeVisible();
    await press(page, "1357");
    await expect(page.getByText("Enter a new PIN")).toBeVisible();
    await press(page, "24");
    await expect(page.locator(".pin-dots i.on")).toHaveCount(2);
    await page.screenshot({ path: shot(`settings_keypad-step2_${width}.png`) });
    await press(page, "68");
    await expect(page.getByText("Enter it again")).toBeVisible();
    await press(page, "1111");
    await expect(page.getByText("The PINs don’t match. Try again.")).toBeVisible();
    await expect(page.getByText("Enter a new PIN")).toBeVisible();
    await expect(page.locator(".pin-dots i.on")).toHaveCount(0);
    await page.screenshot({ path: shot(`settings_mismatch_${width}.png`) });

    await press(page, "2468");
    await expect(page.getByText("Enter it again")).toBeVisible();
    await press(page, "2468");
    await expect(page.locator(".phone-toast")).toContainText("PIN changed");
    await expect(root.locator(".badge", { hasText: "PIN set" })).toBeVisible();
    await page.screenshot({ path: shot(`settings_toast-success_${width}.png`) });
    const verify = await page.request.post("/api/staff/pin/verify", { data: { pin: "2468" } });
    expect(verify.ok(), await verify.text()).toBeTruthy();
    await expect(page.locator(".phone-toast")).toBeHidden();

    await root.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-phone-row="signout"]').click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Sign out of York Currency Exchange?")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Stay signed in" })).toBeVisible();
    if ((await page.locator(".phone-till").innerText()).includes("Till open")) {
      await expect(sheet.getByText("Your till stays open. Hand it off or close it first.")).toBeVisible();
    }
    await page.screenshot({ path: shot(`settings_signout_${width}.png`) });
    await sheet.getByRole("button", { name: "Stay signed in" }).click();
    await expect(root.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  }

  await page.locator('[data-phone-row="signout"]').click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#lock")).toBeVisible();
});

/* The save is intercepted. The first three steps stay on the
   client, and the fourth digit of the last step is the POST. */
async function routePinSave(page: Page, status: number, body: object): Promise<void> {
  await page.route("**/api/staff/pin", async (route) => {
    const req = route.request();
    let path = "";
    try { path = new URL(req.url()).pathname; } catch { path = ""; }
    if (req.method() !== "POST" || path !== "/api/staff/pin") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("a dead session and a PIN lockout are named on the keypad", async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of [360, 390]) {
    await page.unroute("**/api/staff/pin").catch(() => undefined);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 780 });
    await atDesk(page, "j.masri");
    await knownPin(page);
    const root = await openSettings(page);
    await root.getByText("PIN and sign-in").click();
    await page.getByRole("button", { name: "Change my PIN" }).click();
    await press(page, "1357");
    await press(page, "9753");
    await routePinSave(page, 401, { error: "unauthenticated" });
    await press(page, "9753");
    await expect(page.getByText("Your session expired. Sign in again. Your PIN was not changed.")).toBeVisible();
    await expect(page.getByText("That PIN isn’t right.")).toHaveCount(0);
    await expect(page.locator(".keypad button", { hasText: /^1$/ })).toBeDisabled();
    await page.screenshot({ path: shot(`settings_pin-expired_${width}.png`) });
    await page.unroute("**/api/staff/pin");
    await page.getByRole("button", { name: "Close without changing" }).click();

    await page.getByRole("button", { name: "Change my PIN" }).click();
    await press(page, "1357");
    await press(page, "9753");
    await routePinSave(page, 429, { error: "locked" });
    await press(page, "9753");
    await expect(page.getByText("Too many wrong tries. Wait a few minutes.")).toBeVisible();
    await expect(page.locator(".keypad button", { hasText: /^1$/ })).toBeDisabled();
    await page.screenshot({ path: shot(`settings_pin-lockout_${width}.png`) });
    await page.unroute("**/api/staff/pin");
    await page.getByRole("button", { name: "Close without changing" }).click();
  }
});

test("a teller sees only their own settings", async ({ page }) => {
  test.setTimeout(120_000);
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 780 });
    await atDesk(page, "m.costa");
    const root = await openSettings(page);
    await expect(root.getByText("PIN and sign-in")).toBeVisible();
    await expect(root.getByRole("button", { name: "Notifications" })).toBeVisible();
    await expect(root.getByText("Shop settings are managed by the owner.")).toBeVisible();
    await expect(root.locator('[data-phone-row="signout"]')).toBeVisible();
    await expect(root.getByText("This shop. Change on a computer")).toHaveCount(0);
    await expect(root.getByText("Shop details")).toHaveCount(0);
    await expect(root.getByText("Other apps. Change on a computer")).toHaveCount(0);
    await page.screenshot({ path: shot(`settings_list-teller_${width}.png`) });
  }
});

test("settings passes the phone sweep", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await openSettings(page);
  await phoneSweep(page, {
    roots: ["[data-phone-settings]", ".phone-head", "#phone-dock"],
  });
  await page.getByRole("button", { name: "PIN and sign-in" }).click();
  await expect(page.getByRole("heading", { name: "PIN and sign-in" })).toBeVisible();
  await phoneSweep(page, {
    roots: ["[data-phone-settings]", ".phone-head", "#phone-dock"],
  });
  await page.getByRole("button", { name: /my PIN/ }).click();
  await expect(page.locator(".sheet")).toBeVisible();
  await phoneSweep(page, { roots: [".sheet"] });
  await page.getByRole("button", { name: "Close without changing" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Shop details/ }).click();
  await expect(page.getByRole("heading", { name: "Change this on a computer" })).toBeVisible();
  await phoneSweep(page, {
    roots: ["[data-phone-settings]", ".phone-head", "#phone-dock"],
  });
});

test("desktop settings is the rail, with a 0-pixel phone diff", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "j.masri");
  await dismissTour(page);
  await page.locator('#appbar [data-app="settings"]').click();
  await settled(page);
  const phone = page.locator("[data-phone-settings]");
  await expect(phone).toBeHidden();
  const hidden = await phone.evaluate((el) => {
    const style = getComputedStyle(el);
    return { display: style.display, w: el.offsetWidth, h: el.offsetHeight };
  });
  expect(hidden).toEqual({ display: "none", w: 0, h: 0 });
  await expect(page.locator(".sheet")).toHaveCount(0);
  const nav = page.locator(".settings-nav");
  await expect(nav).toBeVisible();
  const width = await nav.evaluate((el) => getComputedStyle(el).width);
  expect(width).toBe("212px");
  const row = await page.locator(".settings-shell").evaluate((el) => getComputedStyle(el).flexDirection);
  expect(row).toBe("row");
  await expect(page.getByText("Legal business name")).toBeVisible();
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  const win = page.locator(".win.show.active");
  let before = await win.screenshot();
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    const next = await win.screenshot();
    if (Buffer.compare(before, next) === 0) { before = next; break; }
    before = next;
  }
  await page.evaluate(() => document.querySelector("[data-phone-settings]")?.remove());
  const after = await win.screenshot();
  expect(Buffer.compare(before, after)).toBe(0);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: shot("settings_desktop_1280.png") });
});
