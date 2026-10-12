/* Phone Settings. 360 and 390 are the phone. 1280 is the desktop
   rail, and the phone list must not paint there. */
import type { Locator, Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { copyFileSync, mkdirSync } from "node:fs";
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

    const shopRow = root.getByRole("button", { name: /Shop details/ });
    await expect(shopRow).toContainText("Name, address, and hours");
    await expect(shopRow).not.toContainText(/phone/i);
    await expect(root.getByRole("button", { name: "Notifications" })).toHaveCount(0);
    await expect(root.getByText("On this phone, for you")).toHaveCount(0);
    await shopRow.click();
    await expect(root.getByRole("heading", { name: "Shop details", exact: true })).toBeVisible();
    await expect(root.getByRole("heading", { name: "Change this on a computer" })).toBeVisible();
    await expect(root.getByText("Shop details are edited on a computer so nothing is changed by accident.")).toBeVisible();
    await expect(root.getByText("Use a computer to change this.")).toHaveCount(0);
    await expect(root.getByText("York Currency Exchange")).toBeVisible();
    await expect(root.getByText(/120 Adelaide/)).toBeVisible();
    await expect(root.getByText("Hours", { exact: true })).toBeVisible();
    await expect(root.getByText("Not set", { exact: true })).toBeVisible();
    await expect(root.getByText("Mon to Fri")).toHaveCount(0);
    await expect(root.getByText("(416) 555-0100")).toHaveCount(0);
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
    const pinRow = root.getByRole("button", { name: /Your PIN/ });
    await expect(pinRow.locator(".d")).toHaveText("Asked when you take a till, switch user or void.");
    await expect(pinRow.locator(".badge")).toHaveText("PIN set");
    await expect(pinRow.locator(".cv")).toBeVisible();
    const chevronAfterBadge = await pinRow.evaluate((el) => {
      const badge = el.querySelector(".badge");
      const chevron = el.querySelector(".cv");
      if (!badge || !chevron) return false;
      return (badge.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(chevronAfterBadge).toBe(true);
    const pinRowHeight = await pinRow.evaluate((el) => el.getBoundingClientRect().height);
    expect(pinRowHeight).toBeGreaterThanOrEqual(44);
    await expect(root.getByText("Always on")).toHaveCount(0);
    await expect(root.getByText("Sign-in code")).toHaveCount(0);
    await expect(root.getByRole("button", { name: "Change my PIN" })).toBeVisible();
    await expect(root.getByText("A void asks for your PIN. The owner sets this.")).toBeVisible();
    await expect(root.getByRole("switch")).toHaveCount(0);
    await page.screenshot({ path: shot(`settings_pin-detail_${width}.png`) });

    await pinRow.click();
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
    await routePinSave(page, 429, { error: "locked", detail: "Too many wrong tries. Try again in a few minutes." });
    await press(page, "9753");
    const sheet = page.locator(".sheet");
    await expect(sheet.getByRole("heading", { name: "PIN locked" })).toBeVisible();
    await expect(sheet.getByRole("alert")).toHaveText("Too many wrong tries. Try again in a few minutes. You can\u2019t switch staff on the till until then.");
    await expect(page.getByText("Enter it again")).toHaveCount(0);
    await expect(page.getByText("The till PIN is locked too.")).toHaveCount(0);
    await expect(sheet.locator(".pin-dots")).toHaveCount(0);
    await expect(sheet.locator(".keypad")).toHaveCount(0);
    await expect(page.getByText(/Try again in \d+:\d{2}/)).toHaveCount(0);
    const close = page.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeVisible();
    const lockDir = "/cursor/stores/self/pr110";
    mkdirSync(lockDir, { recursive: true });
    const lockName = `settings_pin-lockout_${width}.png`;
    await page.screenshot({ path: `${lockDir}/${lockName}` });
    mkdirSync("/opt/cursor/artifacts/pr110", { recursive: true });
    copyFileSync(`${lockDir}/${lockName}`, `/opt/cursor/artifacts/pr110/${lockName}`);
    await page.unroute("**/api/staff/pin");
    await close.click();
    await expect(page.locator(".sheet")).toHaveCount(0);
    await expect(root.getByRole("heading", { name: "PIN and sign-in" })).toBeVisible();
  }
});

/* The cashier route does not send a time. This body is the shape the
   keypad already understands (`retryAfter` seconds, or an ISO end),
   so a later server can name one without the screen inventing it. */
test("a PIN lockout counts down when the server names seconds left", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 360, height: 780 });
  await atDesk(page, "j.masri");
  await knownPin(page);
  const root = await openSettings(page);
  await root.getByText("PIN and sign-in").click();
  await page.getByRole("button", { name: "Change my PIN" }).click();
  await press(page, "1357");
  await press(page, "9753");
  await page.clock.install({ time: new Date("2026-10-12T15:00:00.000Z") });
  await routePinSave(page, 429, { error: "locked", retryAfter: 299 });
  await press(page, "9753");
  await expect(page.locator(".pin-lock")).toHaveText("Too many wrong tries. The till PIN is locked too. Try again in 4:59. The keypad comes back at 11:04 AM.");
  const key = page.locator(".keypad button", { hasText: /^1$/ });
  await expect(key).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
  await page.clock.fastForward(298_000);
  await expect(page.locator(".pin-lock")).toContainText("Try again in 0:01");
  await expect(page.locator(".pin-lock")).toContainText("11:04 AM");
  await expect(key).toBeDisabled();
  await page.clock.fastForward(1_000);
  await expect(key).toBeEnabled();
  await expect(page.getByText("The keypad is back.")).toBeVisible();
  await expect(page.getByText(/Try again in/)).toHaveCount(0);
});

test("a teller sees only their own settings", async ({ page }) => {
  test.setTimeout(120_000);
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 780 });
    await atDesk(page, "m.costa");
    const root = await openSettings(page);
    await expect(root.getByText("PIN and sign-in")).toBeVisible();
    await expect(root.getByRole("button", { name: "Notifications" })).toHaveCount(0);
    await expect(root.getByText("On this phone, for you")).toHaveCount(0);
    await expect(root.getByText("Always on")).toHaveCount(0);
    await expect(root.getByText("Shop settings are managed by the owner.")).toBeVisible();
    await expect(root.locator('[data-phone-row="signout"]')).toBeVisible();
    await expect(root.getByText("This shop. Change on a computer")).toHaveCount(0);
    await expect(root.getByText("Shop details")).toHaveCount(0);
    await expect(root.getByText("Other apps. Change on a computer")).toHaveCount(0);
    const search = root.getByLabel("Search settings");
    for (const hidden of ["billing", "localization", "presets"]) {
      await search.fill(hidden);
      await expect(root.getByRole("button", { name: /Billing and plan/ })).toHaveCount(0);
      await expect(root.getByRole("button", { name: /Localization/ })).toHaveCount(0);
      await expect(root.getByRole("button", { name: /Role presets/ })).toHaveCount(0);
      await expect(root.getByText(new RegExp("Nothing matches “" + hidden + "”"))).toBeVisible();
    }
    await search.fill("payment");
    await expect(root.getByRole("button", { name: /Payment methods/ })).toBeVisible();
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

test("hours someone entered are 12-hour, and a new shop says Not set", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    raw.hours = [
      { days: "Mon–Fri", hours: "9:30am–6:00pm" },
      { days: "Sat–Sun & holidays", hours: "10:00am–5:00pm" },
    ];
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
  });
  await signInAtDesk(page, "j.masri");
  await dismissTour(page);
  const root = await openSettings(page);
  await root.getByRole("button", { name: /Shop details/ }).click();
  await expect(root.getByText("Mon to Fri")).toBeVisible();
  await expect(root.getByText("9:30 AM to 6:00 PM")).toBeVisible();
  await expect(root.getByText("Sat, Sun and holidays")).toBeVisible();
  await expect(root.getByText("10:00 AM to 5:00 PM")).toBeVisible();
  await expect(root.getByText("Not set")).toHaveCount(0);
  await expect(root.locator(".phq-kv")).not.toContainText("–");
});

test("a sign-in code row appears only when this person is emailed one", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body && body.user) body.user.signInCode = true;
    await route.fulfill({ response: res, json: body });
  });
  await atDesk(page, "j.masri");
  const root = await openSettings(page);
  await root.getByText("PIN and sign-in").click();
  await expect(root.getByText("Sign-in code")).toBeVisible();
  await expect(root.getByText("Emailed to you at every sign-in.")).toBeVisible();
  await expect(root.getByText("Always on")).toBeVisible();
});

test("my details saves one field only after the server confirms", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  const calls: Record<string, string>[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/auth/contact", async (route) => {
    const body = route.request().postDataJSON() as Record<string, string>;
    calls.push(body);
    if (body.contactEmail === "nope") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_request", detail: "Enter an email address." }),
      });
      return;
    }
    await gate;
    await route.continue();
  });
  const root = await openSettings(page);
  await root.getByRole("button", { name: /My details/ }).click();
  await expect(page.getByRole("heading", { name: "My details" })).toBeVisible();
  await expect(page.getByText("Work email")).toHaveCount(0);
  await expect(page.getByText("Not the name you sign in with.")).toBeVisible();
  await expect(page.getByLabel("Sign-in")).toHaveValue("j.masri");
  const email = page.getByLabel("Contact email");
  await email.fill("nope");
  await page.getByRole("button", { name: "Save contact email" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter an email address.");
  await expect(email).toHaveValue("nope");
  await expect(page.locator(".phone-toast")).toHaveCount(0);
  expect(Object.keys(calls[0] || {})).toEqual(["contactEmail"]);

  await email.fill("qa.phone@example.com");
  await page.getByRole("button", { name: "Save contact email" }).click();
  await expect(page.getByRole("button", { name: "Saving..." })).toBeVisible();
  await expect(page.locator(".phone-toast")).toHaveCount(0);
  release();
  await expect(page.locator(".phone-toast")).toContainText("Saved");
  expect(Object.keys(calls[1] || {})).toEqual(["contactEmail"]);
  const me = await page.request.get("/api/auth/me");
  expect((await me.json()).user.contactEmail).toBe("qa.phone@example.com");

  await page.getByLabel("Mobile phone").fill("4165550142");
  await page.getByRole("button", { name: "Save mobile phone" }).click();
  await expect(page.locator(".phone-toast")).toContainText("Saved");
  expect(Object.keys(calls[2] || {})).toEqual(["mobilePhone"]);
  expect(calls.some((body) => Object.keys(body).length !== 1)).toBe(false);
});

test("closing my details within a second still saves, and Save cannot fire twice", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  let posts = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/auth/contact", async (route) => {
    posts += 1;
    await gate;
    await route.continue();
  });
  const root = await openSettings(page);
  await root.getByRole("button", { name: /My details/ }).click();
  await page.getByLabel("Contact email").fill("qa.once@example.com");
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save contact email");
    if (!btn) throw new Error("Save contact email is missing");
    btn.click();
    btn.click();
  });
  await expect(page.getByRole("button", { name: "Saving..." })).toBeDisabled();
  expect(posts).toBe(1);
  release();
  await expect(page.locator(".phone-toast")).toContainText("Saved");

  posts = 0;
  let started = 0;
  let leftBody: Record<string, string> = {};
  let leftDone = false;
  await page.unroute("**/api/auth/contact");
  await page.route("**/api/auth/contact", async (route) => {
    started += 1;
    leftBody = route.request().postDataJSON() as Record<string, string>;
    await new Promise((r) => setTimeout(r, 900));
    await route.continue();
    leftDone = true;
  });
  await expect(page.locator(".phone-toast")).toBeHidden();
  await page.getByLabel("Mobile phone").fill("4165550177");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(root.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  expect(started).toBe(1);
  expect(leftBody).toEqual({ mobilePhone: "4165550177" });
  await expect.poll(() => leftDone).toBe(true);
  await expect(page.locator(".phone-toast")).toContainText("Saved");
  const me = await page.request.get("/api/auth/me");
  expect((await me.json()).user.mobilePhone).toBe("4165550177");
});

test("a double tap on password Save sends one request", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  let posts = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/auth/change-password", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    posts += 1;
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  const root = await openSettings(page);
  await root.getByText("PIN and sign-in").click();
  await page.getByRole("button", { name: /^Password/ }).click();
  await page.getByLabel("Current password").fill("yorkville");
  await page.locator("label", { hasText: /^New password$/ }).locator("input").fill("yorkville-next");
  await page.getByLabel("New password again").fill("yorkville-next");
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save");
    if (!btn) throw new Error("Save is missing");
    btn.click();
    btn.click();
  });
  await expect(page.getByRole("button", { name: "Saving..." })).toBeDisabled();
  expect(posts).toBe(1);
  release();
  await expect(page.locator(".phone-toast")).toContainText("Password changed");
});

test("a long, zero, negative, or past PIN wait does not read as minutes", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 780 });
  await atDesk(page, "j.masri");
  await knownPin(page);
  const root = await openSettings(page);
  await root.getByText("PIN and sign-in").click();
  await page.getByRole("button", { name: "Change my PIN" }).click();
  await press(page, "1357");
  await press(page, "9753");
  await page.clock.install({ time: new Date("2026-10-12T15:00:00.000Z") });
  await routePinSave(page, 429, { error: "locked", retryAfter: 86400 });
  await press(page, "9753");
  await expect(page.locator(".pin-lock")).toHaveText("Too many wrong tries. The till PIN is locked too. Try again in 24:00:00. The keypad comes back at 11:00 AM.");
  await expect(page.locator(".pin-lock")).not.toContainText("1440");
  await page.unroute("**/api/staff/pin");
  await page.getByRole("button", { name: "Close without changing" }).click();

  for (const body of [
    { error: "locked", retryAfter: 0 },
    { error: "locked", retryAfter: -30 },
    { error: "locked", lockedUntil: "2026-10-12T14:00:00.000Z" },
  ]) {
    await page.getByRole("button", { name: "Change my PIN" }).click();
    await press(page, "1357");
    await press(page, "9753");
    await routePinSave(page, 429, body);
    await press(page, "9753");
    await expect(page.getByText("The keypad is back.")).toBeVisible();
    await expect(page.locator(".keypad button", { hasText: /^1$/ })).toBeEnabled();
    await expect(page.locator(".pin-lock")).toHaveCount(0);
    await page.unroute("**/api/staff/pin");
    await page.getByRole("button", { name: "Close without changing" }).click();
  }
});

test("a teller's wrong PIN warns, then names when the till PIN unlocks", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await atDesk(page, "m.costa");
    const set = await page.request.post("/api/staff/pin/reset", { data: { password: "yorkville", pin: "1357" } });
    expect(set.ok(), await set.text()).toBeTruthy();
    const root = await openSettings(page);
    await root.getByText("PIN and sign-in").click();
    await expect(root.getByText("Always on")).toHaveCount(0);
    await page.getByRole("button", { name: "Change my PIN" }).click();
    await press(page, "0000");
    await expect(page.getByText("That PIN isn’t right. 4 tries left.")).toBeVisible();
    await expect(page.getByText("Enter a new PIN")).toHaveCount(0);
    await expect(page.getByText("Enter your current PIN")).toBeVisible();
    for (let i = 0; i < 4; i++) await press(page, "0000");
    const lock = page.locator(".pin-lock");
    await expect(lock).toContainText("The till PIN is locked too");
    await expect(lock).toContainText(/Try again in \d+:\d{2}/);
    await expect(lock).toContainText(/The keypad comes back at \d{1,2}:\d{2} (AM|PM)/);
    await expect(lock).not.toContainText("1440");
    await expect(page.locator(".pin-err")).toHaveCount(0);
    const above = await page.locator(".pinpad").evaluate((el) => {
      const banner = el.querySelector(".pin-lock");
      const question = el.querySelector(".pin-q");
      if (!banner || !question) return false;
      return (banner.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(above).toBe(true);
  } finally {
    await page.request.post("/api/auth/login", {
      data: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    await page.request.post("/api/staff/m.costa/pin");
  }
});
