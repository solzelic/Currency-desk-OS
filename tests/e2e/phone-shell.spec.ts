/* Phone shell. More, the shared money formatter, and the five-tab bar. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";
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
  expect(owner).not.toContain("Assistant");
  expect(owner).not.toContain("AI Assistant");
  await expect(page.locator("#phone-more [data-phone-app='telegraph']")).toHaveCount(0);
  await expect(page.locator("#phone-more [data-phone-app='branches']")).toHaveCount(0);
  await expect(page.locator("#phone-more [data-phone-app='assistant']")).toHaveCount(0);

  await atDesk(page, "m.costa");
  const cashier = await moreNames(page);
  expect(cashier).not.toContain("Settings");
  expect(cashier).not.toContain("Vault");
  expect(cashier).not.toContain("Reports");
  expect(cashier).not.toContain("Dashboard");
  expect(cashier).toContain("Cheques");
  expect(cashier).toContain("Apps");
});

test("the default desk hides Texts, Branches, and the AI Assistant", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  const names = await moreNames(page);
  for (const hidden of ["Texts", "Branches", "Assistant", "AI Assistant"]) {
    expect(names, hidden).not.toContain(hidden);
  }
  await expect(page.locator("#phone-more [data-phone-app='telegraph']")).toHaveCount(0);
  await expect(page.locator("#phone-more [data-phone-app='branches']")).toHaveCount(0);
  await expect(page.locator("#phone-more [data-phone-app='assistant']")).toHaveCount(0);
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
const CHIP = "rgb(22, 21, 19)";

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
    let chip = null;
    if (chipEl) {
      const buttonBg = getComputedStyle(chipEl).backgroundColor;
      const face = chipEl.querySelector(":scope > span");
      const faceBg = face ? getComputedStyle(face).backgroundColor : buttonBg;
      chip = buttonBg === "rgba(0, 0, 0, 0)" || buttonBg === "transparent" ? faceBg : buttonBg;
    }
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
  expect(ledger.chip).toBe(CHIP);

  await page.locator('#phonebar [data-phone-app="clients"]').click();
  await dismissTour(page);
  const clients = await accentOf(page, "clients", "New contact");
  expect(clients.appAttr).toBe("clients");
  expect(clients.brand).toBe(ACCENT.clients);
  expect(clients.button.split("|")).toEqual([ACCENT.clients]);
  expect(clients.chip).toBe(CHIP);

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

test("the title and the first chip sit in from the edge", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await dismissTour(page);
  await expect(page.locator(".phone-ledger .phone-title h1")).toBeVisible();
  for (const size of [{ width: 360, height: 780 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    const box = await page.evaluate(() => {
      const title = document.querySelector(".phone-ledger .phone-title h1");
      const chip = document.querySelector(".phone-ledger .phone-chip");
      const shell = document.querySelector(".phone-ledger [data-phone-shell]");
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--color-surface)";
      document.body.appendChild(probe);
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const paint = shell ? getComputedStyle(shell) : null;
      return {
        title: title ? title.getBoundingClientRect().left : -1,
        chip: chip ? chip.getBoundingClientRect().left : -1,
        bg: paint ? paint.backgroundColor : "",
        image: paint ? paint.backgroundImage : "",
        surface,
      };
    });
    expect(box.title, `${size.width} title`).toBeGreaterThanOrEqual(16);
    expect(box.chip, `${size.width} chip`).toBeGreaterThanOrEqual(16);
    expect(box.image, `${size.width} flat`).toBe("none");
    expect(box.bg, `${size.width} surface`).toBe(box.surface);
  }
});

/* The title used to sit flush under the top bar. 16px is the title's
   top padding. 12px is what it keeps before the next element. */
test("the title sits 16px under the top bar at 360", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await dismissTour(page);
  await expect(page.locator(".phone-ledger .phone-title h1")).toBeVisible();
  const gap = await page.evaluate(() => {
    const head = document.querySelector(".phone-head");
    const title = document.querySelector(".phone-ledger .phone-title");
    const heading = title && title.querySelector("h1");
    const scroll = title && title.parentElement && title.parentElement.querySelector(":scope > .phone-scroll");
    const next = scroll && scroll.firstElementChild;
    if (!head || !title || !heading || !next) return null;
    const titleBox = title.getBoundingClientRect();
    const style = getComputedStyle(title);
    const padBottom = parseFloat(style.paddingBottom);
    return {
      underBar: heading.getBoundingClientRect().top - head.getBoundingClientRect().bottom,
      afterTitle: next.getBoundingClientRect().top - (titleBox.bottom - padBottom),
      padTop: parseFloat(style.paddingTop),
      padBottom,
      next: next.className,
    };
  });
  expect(gap).not.toBeNull();
  expect(gap!.padTop).toBe(16);
  expect(gap!.padBottom).toBe(12);
  expect(gap!.underBar).toBe(16);
  expect(gap!.afterTitle).toBe(12);
});

/* A long station and till name used to wrap "open" or "closed"
   onto a second line at 360, so the header grew. The desk name is
   what gets cut. The status stays whole. */
async function seedLongDesk(page: Page, closed = false): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.waitForFunction(() => {
    const stations = window.CDOS && window.CDOS._stations;
    return !!(stations && stations.defaultBranches && stations.SKEY);
  });
  await page.evaluate(() => {
    const stations = window.CDOS._stations;
    const branches = stations.defaultBranches();
    const branch = branches.find((item) => item.id === "b01") || branches[0];
    const till = (branch.tills || []).find((item) => item.teller === "A. Singh") || (branch.tills || [])[0];
    branch.name = "Front Desk 01";
    till.name = "Wholesale desk";
    sessionStorage.setItem("phone-top-seed", JSON.stringify({
      skey: stations.SKEY,
      branches,
      station: { branchId: branch.id, tillId: till.id },
      operatingName: "York Currency Exchange on Adelaide Street West",
      closed,
    }));
  });
  await page.addInitScript(() => {
    const raw = sessionStorage.getItem("phone-top-seed");
    if (!raw) return;
    const seed = JSON.parse(raw);
    localStorage.setItem(seed.skey, JSON.stringify(seed.branches));
    localStorage.setItem("cdos_station_v1", JSON.stringify(seed.station));
    const settings = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    settings.operatingName = seed.operatingName;
    localStorage.setItem("cdos_settings", JSON.stringify(settings));
    localStorage.setItem("cdos_day", JSON.stringify({
      closed: !!seed.closed, closedAt: null, closedBy: null, summary: null, num: 1,
    }));
  });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
}

async function topBarMeasure(page: Page) {
  return page.locator(".phone-head").evaluate((head) => {
    const shop = head.querySelector(".phone-shop-name");
    const till = head.querySelector(".phone-till");
    const line = head.querySelector(".phone-till-line");
    const state = head.querySelector(".phone-till-state");
    const dot = head.querySelector(".phone-till-dot");
    const bell = head.querySelector(".phone-bell");
    const desk = head.querySelector(".phone-till-part.is-desk .phone-till-where");
    const tillName = head.querySelector(".phone-till-part:not(.is-desk) .phone-till-where");
    const wheres = [...head.querySelectorAll(".phone-till-where")];
    if (!(shop instanceof HTMLElement) || !(till instanceof HTMLElement) || !(line instanceof HTMLElement) || !(state instanceof HTMLElement) || !(dot instanceof HTMLElement) || !(bell instanceof HTMLElement) || !(desk instanceof HTMLElement)) {
      return null;
    }
    const headBox = head.getBoundingClientRect();
    const stateBox = state.getBoundingClientRect();
    const bellBox = bell.getBoundingClientRect();
    const lineBox = line.getBoundingClientRect();
    const dotBox = dot.getBoundingClientRect();
    const clipped = (el: Element) => el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1;
    const oneLine = (el: Element) => el.getClientRects().length === 1;
    return {
      height: Math.round(headBox.height),
      shopLines: shop.getClientRects().length,
      shopClipped: shop.scrollWidth > shop.clientWidth + 1,
      lineLines: line.getClientRects().length,
      lineClipped: line.scrollWidth > line.clientWidth + 1,
      tillHeight: Math.round(till.getBoundingClientRect().height),
      middle: wheres.map((el) => el.textContent || "").join(" · "),
      middleClipped: wheres.some((el) => clipped(el)),
      deskClipped: clipped(desk),
      deskOneLine: oneLine(desk),
      tillName: tillName ? (tillName.textContent || "") : "",
      tillNameWhole: tillName instanceof HTMLElement ? !clipped(tillName) && oneLine(tillName) : true,
      status: (state.textContent || "").replace(/^\s*·\s*/, ""),
      statusLines: state.getClientRects().length,
      statusWhole: state.scrollWidth <= state.clientWidth + 1 && stateBox.right <= bellBox.left + 1 && stateBox.right <= lineBox.right + 1 && stateBox.top >= lineBox.top - 1 && stateBox.bottom <= lineBox.bottom + 1,
      dotVisible: dotBox.width >= 8 && dotBox.left >= headBox.left && dotBox.right <= lineBox.left + 1,
    };
  });
}

test("the top bar is the same height at 360 and 390 with a long desk name", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await seedLongDesk(page);
  await expect(page.locator(".phone-head")).toBeVisible();
  const at360 = await topBarMeasure(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const at390 = await topBarMeasure(page);
  expect(at360).not.toBeNull();
  expect(at390).not.toBeNull();
  expect(at360!.height).toBe(at390!.height);
  expect(at360!.height).toBe(56);
  expect(at360!.shopLines).toBe(1);
  expect(at390!.shopLines).toBe(1);
  expect(at360!.shopClipped).toBe(true);
  expect(at360!.lineLines).toBe(1);
  expect(at390!.lineLines).toBe(1);
  expect(at360!.tillHeight).toBeLessThanOrEqual(16);
  expect(at390!.tillHeight).toBeLessThanOrEqual(16);
  expect(at360!.middle).toContain("Front Desk 01");
  expect(at360!.middle).toContain("Wholesale desk");
  expect(at360!.status).toBe("Till open");
  expect(at390!.status).toBe("Till open");
  expect(at360!.statusLines).toBe(1);
  expect(at360!.statusWhole).toBe(true);
  expect(at390!.statusWhole).toBe(true);
  expect(at360!.deskClipped).toBe(true);
  expect(at360!.deskOneLine).toBe(true);
  expect(at360!.dotVisible).toBe(true);
});

/* "Till closed" is longer than "Till open". At 360 the word "closed"
   used to drop onto its own line. Reports uses the same header. */
test("the top bar is one line at 360 when the till is closed", async ({ page }) => {
  await page.route("**/api/ledger/till-session", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: null }),
    });
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await seedLongDesk(page, true);
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="reports"]').click();
  await expect(page.locator('.win.show.active[data-app="reports"]')).toBeVisible();
  await expect(page.locator(".phone-till-state")).toHaveText(/Till closed/);
  const bar = await topBarMeasure(page);
  expect(bar).not.toBeNull();
  expect(bar!.height).toBe(56);
  expect(bar!.tillHeight).toBeLessThanOrEqual(16);
  expect(bar!.lineLines).toBe(1);
  expect(bar!.status).toBe("Till closed");
  expect(bar!.statusLines).toBe(1);
  expect(bar!.statusWhole).toBe(true);
  expect(bar!.deskClipped).toBe(true);
  expect(bar!.deskOneLine).toBe(true);
  expect(bar!.tillName).toBe("Wholesale desk");
  expect(bar!.tillNameWhole).toBe(true);
  expect(bar!.dotVisible).toBe(true);
  expect(bar!.shopLines).toBe(1);
});

test("Ledger passes the phone sweep", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await dismissTour(page);
  await expect(page.locator(".phone-ledger")).toBeVisible();
  await expect(page.getByRole("button", { name: "New transaction", exact: true })).toBeVisible();
  await phoneSweep(page, {
    roots: [".phone-ledger", ".phone-head", "#phone-dock"],
  });
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
  await expect(page.locator("#phone-more .phone-sticky")).toHaveCount(0);
  await page.locator("#phone-more .phone-session-row.is-danger").click();
  const sticky = page.locator("#phone-more .phone-sticky");
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

/* The day starts open in this browser, then the server can say it
   is shut. Open it before clicking New transaction, or the click
   lands on a button that disables mid-press. */
async function tillOpen(page: Page): Promise<void> {
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
  if (opened === "no-ledger") return;
  expect(opened, "the till did not open").toBe("open");
  const sync = page.waitForResponse((r) => r.url().includes("/api/ledger/till-session") && r.ok());
  await page.reload();
  await landOnDesktop(page);
  await sync;
  await dismissTour(page);
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

test("a task sheet covers the tab bar", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page, "a.singh");
  await tillOpen(page);
  await page.locator('#phonebar [data-phone-app="ledger"]').click();
  await dismissTour(page);
  const open = page.getByRole("button", { name: "New transaction", exact: true });
  await expect(open).toBeEnabled();
  await open.click();
  const sheet = page.locator(".phone-task-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("New transaction", { exact: true })).toBeVisible();
  const close = sheet.locator(".phone-task-close");
  const closeBox = await close.boundingBox();
  expect(closeBox, "close").toBeTruthy();
  expect(Math.round(closeBox!.width)).toBe(44);
  expect(Math.round(closeBox!.height)).toBe(44);
  const place = await page.locator(".phone-task-go").evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const panel = document.querySelector(".phone-task-sheet");
    const dock = document.getElementById("phone-dock");
    const panelBox = panel ? panel.getBoundingClientRect() : null;
    const dockBox = dock ? dock.getBoundingClientRect() : null;
    return {
      hit: !!(hit && el.contains(hit)),
      dock: !!(hit && hit.closest("#phone-dock")),
      sheetTop: panelBox ? panelBox.top : 99,
      sheetBottom: panelBox ? panelBox.bottom : 0,
      dockTop: dockBox ? dockBox.top : 0,
      height: window.innerHeight,
    };
  });
  expect(place.hit, "main button is the element at its centre").toBe(true);
  expect(place.dock, "main button is not the bar").toBe(false);
  expect(place.sheetTop, "sheet").toBeLessThanOrEqual(1);
  expect(place.sheetBottom, "sheet covers the bar").toBeGreaterThanOrEqual(place.height - 2);
  expect(place.sheetBottom, "sheet crosses the bar").toBeGreaterThan(place.dockTop + 8);

  await page.locator(".cd-tx-customer input").fill("Ada");
  await close.click();
  const confirm = page.locator(".phone-confirm-sheet");
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute("aria-label", "Discard this deal?");
  const confirmPlace = await confirm.evaluate((el) => {
    const card = el.getBoundingClientRect();
    const dock = document.getElementById("phone-dock");
    const dockBox = dock ? dock.getBoundingClientRect() : null;
    return {
      cardBottom: card.bottom,
      dockTop: dockBox ? dockBox.top : 0,
    };
  });
  expect(confirmPlace.cardBottom, "confirm stays above the bar").toBeLessThanOrEqual(confirmPlace.dockTop + 1);
});
