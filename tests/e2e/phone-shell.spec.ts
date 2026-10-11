/* Phone shell. More, the shared money formatter, and the five-tab bar. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const PHONE = { width: 390, height: 844 };

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

async function atDesk(page: Page, staffId: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, staffId);
  await dismissTour(page);
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function moreNames(page: Page): Promise<string[]> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator("#phone-more")).toBeVisible();
  return page.locator("#phone-more .phone-more-name").allTextContents();
}

test("amounts show the currency code", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  const money = await page.evaluate(() => {
    const format = window.CDOS.formatPhoneMoney;
    return {
      cad: format(1765.05, "CAD"),
      jpy: format(1200, "JPY"),
      bhd: format(1.234, "BHD"),
      absent: format(null, "CAD"),
      blank: format("", "CAD"),
      nan: format("nope", "USD"),
      neg: format(-5, "USD"),
      zero: format(0, "JPY"),
      same: format(1765.05, "CAD") === window.CDOS.Phone.formatMoney(1765.05, "CAD"),
    };
  });
  expect(money.cad).toBe("1,765.05 CAD");
  expect(money.jpy).toBe("1,200 JPY");
  expect(money.bhd).toBe("1.234 BHD");
  expect(money.absent).toBe("");
  expect(money.blank).toBe("");
  expect(money.nan).toBe("");
  expect(money.neg).toBe("\u22125.00 USD");
  expect(money.zero).toBe("0 JPY");
  expect(money.same).toBe(true);
  expect(money.cad).not.toContain("$");
});

test("the bar is five tabs and has no centre plus", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  await expect(page.locator("#phonebar .phone-tab")).toHaveCount(5);
  await expect(page.locator("#phonebar .lbl")).toHaveText(["Rates", "Ledger", "Clients", "Till", "More"]);
  await expect(page.locator("#phone-fab")).toHaveCount(0);
  await expect(page.locator("#phonebar").getByRole("button", { name: "+" })).toHaveCount(0);
});

test("an owner sees Settings and a cashier does not", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "j.masri");
  const owner = await moreNames(page);
  expect(owner).toContain("Settings");
  expect(owner).toContain("Vault");
  expect(owner).not.toContain("Texts");
  expect(owner).not.toContain("Branches");
  await expect(page.locator("#phone-more [data-phone-app='telegraph']")).toHaveCount(0);
  await expect(page.locator("#phone-more [data-phone-app='branches']")).toHaveCount(0);

  await atDesk(page, "m.costa");
  const cashier = await moreNames(page);
  expect(cashier).not.toContain("Settings");
  expect(cashier).not.toContain("Vault");
  expect(cashier).not.toContain("Reports");
  expect(cashier).not.toContain("Dashboard");
  expect(cashier).toContain("Cheques");
  expect(cashier).toContain("Apps");
});

test("cash finds the apps that handle cash", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.getByRole("textbox", { name: "Search apps" }).fill("cash");
  await expect(page.locator("#phone-more")).toContainText('Results for "cash"');
  const names = await page.locator("#phone-more .phone-more-name").allTextContents();
  expect(names).toEqual(["Cheques", "Vault", "Compliance", "Till"]);
  await expect(page.locator("#phone-more")).toContainText("On the bottom bar");
  await expect(page.locator("#phone-more")).toContainText("Search looks at app names and what each app does.");
  await expect(page.locator("#phone-more")).not.toContainText("Example data");

  await atDesk(page, "m.costa");
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.getByRole("textbox", { name: "Search apps" }).fill("cash");
  const cashier = await page.locator("#phone-more .phone-more-name").allTextContents();
  expect(cashier).toEqual(["Cheques", "Compliance", "Till"]);
});

const ACCENT: Record<string, string> = {
  ledger: "rgb(29, 107, 69)",
  clients: "rgb(60, 59, 120)",
  transfers: "rgb(31, 114, 105)",
};

async function accentOf(page: Page, app: string, label: string): Promise<{ appAttr: string | null; button: string; brand: string; chip: string | null }> {
  return page.evaluate(({ app, label }) => {
    const win = document.querySelector(`.win.active[data-app="${app}"]`) || document.querySelector(`.win[data-app="${app}"]`);
    if (!(win instanceof HTMLElement)) return { appAttr: null, button: "missing window", brand: "", chip: null };
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--brand-primary)";
    win.appendChild(probe);
    const brand = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const visible = (el: Element) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const box = el.getBoundingClientRect();
      return box.width >= 1 && box.height >= 1;
    };
    const buttons = [...win.querySelectorAll("button")].filter((el) => visible(el) && (el.textContent || "").replace(/\s+/g, " ").includes(label));
    const button = buttons.length
      ? buttons.map((el) => getComputedStyle(el).backgroundColor).join("|")
      : "missing button";
    const chipEl = [...win.querySelectorAll("button")].find((el) => visible(el) && /^All\b/.test((el.innerText || "").trim()));
    const chip = chipEl ? getComputedStyle(chipEl).backgroundColor : null;
    return { appAttr: win.getAttribute("data-app"), button, brand, chip };
  }, { app, label });
}

test("primary buttons use the open app's accent", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");

  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await dismissTour(page);
  const ledger = await accentOf(page, "ledger", "New transaction");
  expect(ledger.appAttr).toBe("ledger");
  expect(ledger.brand).toBe(ACCENT.ledger);
  expect(ledger.button.split("|")).toEqual([ACCENT.ledger]);

  await page.locator('#phonebar [data-phone-app="clients"]').click();
  await dismissTour(page);
  const clients = await accentOf(page, "clients", "New contact");
  expect(clients.appAttr).toBe("clients");
  expect(clients.brand).toBe(ACCENT.clients);
  expect(clients.button.split("|")).toEqual([ACCENT.clients]);
  expect(clients.chip).toBe(ACCENT.clients);

  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="transfers"]').click();
  await dismissTour(page);
  const transfers = await accentOf(page, "transfers", "New transfer");
  expect(transfers.appAttr).toBe("transfers");
  expect(transfers.brand).toBe(ACCENT.transfers);
  for (const fill of transfers.button.split("|")) expect(fill).toBe(ACCENT.transfers);

  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1280, height: 800 });
  /* The ink fill transitions off the phone accent. Read it once that
     settles, and confirm the phone query is no longer matching. */
  await expect.poll(async () => page.evaluate(() => {
    const win = document.querySelector('.win[data-app="ledger"]');
    const btn = win && [...win.querySelectorAll("button")].find((el) => (el.textContent || "").includes("New transaction"));
    return {
      bg: btn ? getComputedStyle(btn).backgroundColor : "missing",
      media: window.matchMedia("(max-width: 430px)").matches,
      width: window.innerWidth,
    };
  })).toEqual({ bg: "rgb(10, 10, 10)", media: false, width: 1280 });
});

test("More passes the phone sweep", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator("#phone-more")).toBeVisible();
  await phoneSweep(page, {
    roots: ["#phone-more", ".phone-head", "#phone-dock"],
  });
});

test("sign out asks first and the sticky action clears the last row", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator(".phone-sticky")).toHaveCount(0);
  await page.locator("#phone-more .phone-session-row.is-danger").click();
  const sticky = page.locator(".phone-sticky");
  await expect(sticky).toBeVisible();
  await expect(sticky.getByRole("button", { name: "Sign out" })).toBeVisible();
  const overlap = await page.evaluate(() => {
    const scroller = document.querySelector("#phone-more .phone-scroll");
    const last = document.querySelector("#phone-more .phone-session-row.is-danger");
    const bar = document.querySelector("#phone-more .phone-sticky");
    if (!(scroller instanceof HTMLElement) || !(last instanceof HTMLElement) || !(bar instanceof HTMLElement)) {
      return "missing";
    }
    last.scrollIntoView({ block: "end" });
    const row = last.getBoundingClientRect();
    const pin = bar.getBoundingClientRect();
    return row.bottom <= pin.top + 1 ? "clear" : `row ${Math.round(row.bottom)} sticky ${Math.round(pin.top)}`;
  });
  expect(overlap).toBe("clear");
  await sticky.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#lock")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
