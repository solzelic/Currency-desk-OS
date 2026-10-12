/* Phone Compliance. Narrow windows use the phone home once the shared
   money formatter is loaded. A wide window keeps the desktop Compliance
   window, pixel for pixel. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

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

async function sweepCompliance(page: Page): Promise<void> {
  const win = page.locator(".win.show.active");
  /* The window fades and scales in. Measuring during that scale
     reports a 44px control as 43px. Wait until it has settled,
     then sweep that width. */
  for (const width of [360, 390] as const) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await expect(win).toHaveCSS("transform", "none");
    await expect(win).toHaveCSS("opacity", "1");
    await phoneSweep(page, {
      roots: [".win.show.active [data-phone-shell][data-app='compliance']"],
      widths: [width],
    });
  }
}

/* The till separator is a flex item. A normal space at its edge is
   clipped, so the line reads "01·Till". The painted gap has to be
   wider than the dot alone. */
async function expectTillGaps(page: Page): Promise<void> {
  const measured = await page.locator(".phone-till-line").evaluate((line) => {
    const sep = line.querySelector(".phone-till-sep");
    const state = line.querySelector(".phone-till-state");
    const widthOf = (el: Element | null) => {
      if (!el) return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const probe = document.createElement("span");
    probe.textContent = "·";
    probe.style.font = getComputedStyle(line).font;
    line.appendChild(probe);
    const dotWidth = probe.getBoundingClientRect().width;
    probe.remove();
    const text = (value: string | null | undefined) => (value || "").replace(/\u00A0/g, " ");
    return {
      sepText: text(sep && sep.textContent),
      stateText: text(state && state.textContent).trim(),
      sepWidth: widthOf(sep),
      dotWidth,
    };
  });
  expect(measured.sepText).toBe(" · ");
  expect(measured.stateText).toMatch(/^Till (open|closed)$/);
  expect(measured.sepWidth).toBeGreaterThan(measured.dotWidth * 2);
}

async function expectAvatarFont(page: Page): Promise<void> {
  const font = await page.locator(".phone-head .mb-acct-av").evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font.toLowerCase()).not.toMatch(/mono|plex/);
  expect(font.toLowerCase()).toMatch(/archivo|inter/);
}

async function expectRowsFit(root: ReturnType<Page["locator"]>): Promise<void> {
  const clipped = await root.locator(".phone-row-sub").evaluateAll((els) =>
    els
      .filter((el) => el instanceof HTMLElement && el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 1)
      .map((el) => (el.textContent || "").trim())
  );
  expect(clipped).toEqual([]);
}

/* The window fades in under the fixed top bar. A shot taken during
   that fade washes out everything below the bar. */
async function settled(page: Page): Promise<void> {
  const win = page.locator(".win.show.active").first();
  await expect(win).toHaveCSS("transform", "none");
  await expect(win).toHaveCSS("opacity", "1");
}

async function shot(page: Page, name: string): Promise<void> {
  for (const width of [390, 360] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 780 });
    await settled(page);
    await page.screenshot({ path: `test-results/compliance_${name}_${width}.png`, fullPage: false });
  }
}

/* Screenshot fixture only. These deals live in this browser's local row
   store for one test. They are not posted, not seeded, and not the
   Yorkville demo book. Canada leaves a deal already at 10,000 as its
   own filing, and it adds two or more under-line cash deals in the
   same static day into one 24-hour report. Same-day under-line deals
   are also the split-deal watch. */
function screenshotDeals(day: string) {
  const cash = (id: string, ref: string, time: string, customer: string, inAmt: number) => ({
    id,
    ref,
    date: day,
    time,
    customer,
    beneficiary: "",
    type: "Currency Exchange",
    inCcy: "CAD",
    inAmt,
    outCcy: "USD",
    outAmt: 1,
    status: "posted",
    filed: false,
    ackStr: false,
    voidReason: "",
    voidBy: "",
    voidAt: "",
  });
  const passport = (idNum: string) => ({ idType: "Passport", idNum, idExpiry: "2030-06-01" });
  return {
    rows: [
      cash("fx-filing", "LT-FILING-10000", "09:10", "Amina Farah", 10000),
      cash("fx-split-a", "LT-SPLIT-A", "10:15", "Noah Pell", 3200),
      cash("fx-split-b", "LT-SPLIT-B", "13:40", "Noah Pell", 3400),
      cash("fx-split-c", "LT-SPLIT-C", "17:05", "Noah Pell", 3600),
      cash("fx-agg-a", "LT-AGG-A", "11:05", "Leah Cho", 5500),
      cash("fx-agg-b", "LT-AGG-B", "16:30", "Leah Cho", 4800),
      cash("fx-missing", "LT-MISSING-ID", "14:20", "Sam Idris", 4000),
    ],
    clients: {
      "Amina Farah": passport("P100001"),
      "Noah Pell": passport("P200002"),
      "Leah Cho": passport("P300003"),
    },
  };
}

async function installScreenshotFixtures(page: Page): Promise<{ day: string; label: string }> {
  const stamp = await page.evaluate(() => {
    const day = String(window.CDOS.businessDate()).slice(0, 10);
    const parts = day.split("-").map(Number);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const md = months[parts[1] - 1] + " " + parts[2];
    return { day, row: "Today", heading: "Today, " + md };
  });
  const book = screenshotDeals(stamp.day);
  await page.evaluate((payload) => {
    localStorage.setItem("cdos_rows_v1", JSON.stringify(payload.rows));
    localStorage.setItem("cdos_clients_v1", JSON.stringify(payload.clients));
  }, book);
  await page.reload({ waitUntil: "domcontentloaded" });
  await landOnDesktop(page);
  await dismissTour(page);
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
  return stamp;
}

async function openCompliance(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="compliance"]').click();
  await expect(page.locator(".win.show.active .win-title")).toContainText("Compliance");
}

test("desktop Compliance is unchanged at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page, "j.masri");
  await page.locator('#appbar [data-app="compliance"]').click();
  await expect(page.locator(".win.show.active .win-title")).toContainText("Compliance");
  await expect(page.getByTestId("compliance-phone-home")).toHaveCount(0);
  await expect(page.getByTestId("sanctions-screening-tile")).toContainText("Not connected");
  await expect(page.locator("#phonebar")).toBeHidden();
  /* The 1280 picture of this window is tests/e2e/desktop-unchanged.spec.ts.
     That spec is the foundation's. This screen does not keep a copy. */
});

test("owner and teller phone homes stay honest", async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 780 });
    for (const [staff, role] of [["j.masri", "owner"], ["m.costa", "teller"]] as const) {
      await atDesk(page, staff);
      const spelled = await page.evaluate(() => {
        const root = window.CDOS || {};
        const fn = root.formatPhoneMoney || (root.Phone && root.Phone.formatMoney);
        return typeof fn === "function" ? fn(10000, "CAD") : "";
      });
      expect(spelled, "shared phone money formatter").toMatch(/10,000(\.00)? CAD/);
      expect(spelled).not.toContain("$");
      await openCompliance(page);
      const shell = page.locator('[data-phone-shell][data-app="compliance"]');
      const home = shell.getByTestId("compliance-phone-home");
      await expect(home).toBeVisible();
      await expect(home).toHaveAttribute("data-state", "ready");
      await expect(shell).toContainText("Compliance");
      await expect(shell).toContainText(spelled);
      await expect(shell).toContainText("financial intelligence unit");
      await expect(home).toContainText("You file");
      await expect(home).toContainText("does not send the report");
      const tile = home.getByTestId("sanctions-screening-tile");
      await expect(tile).toContainText("Not connected");
      await expect(tile).toContainText("No list provider is connected yet");
      expect(await tile.innerText()).not.toMatch(/\d/);
      await expect(home.getByText("Automatic ID checks")).toBeVisible();
      await expect(home.getByRole("button", { name: "Open Clients" })).toBeVisible();
      await expect(page.locator("#phone-fab")).toHaveCount(0);
      await expectTillGaps(page);
      await expectAvatarFont(page);
      await expect(page.locator("#phonebar .phone-tab")).toHaveCount(5);
      const more = page.locator('#phonebar [data-phone-app="more"].is-on .lbl');
      await expect(more).toHaveCSS("color", "rgb(107, 46, 84)");
      const selectedChip = home.locator(".phone-chip.is-on > span");
      await expect(selectedChip).toHaveCSS("background-color", "rgb(22, 21, 19)");
      await expect(selectedChip).toHaveCSS("color", "rgb(255, 255, 255)");
      const homeText = await shell.innerText();
      expect(homeText).not.toContain("Use the current Canada rules");
      expect(homeText).not.toContain("Change in Settings");
      expect(homeText).not.toMatch(/\$/);
      await settled(page);
      await page.screenshot({
        path: `test-results/compliance_home_${role}_${width}.png`,
        fullPage: false,
      });
      if (role === "owner" && width === 390) {
        await home.getByRole("button", { name: /Reportable/ }).click();
        await expect(shell.locator("h1")).toHaveText("What you would file");
        await shell.getByRole("button", { name: "Compliance", exact: true }).click();
        await expect(home).toBeVisible();
        await home.getByRole("tab", { name: "24-hour rule" }).click();
        await home.getByRole("button", { name: /Possible split deals/ }).click();
        await expect(shell.locator("h1")).toHaveText("Possible split deals");
        await shell.getByRole("button", { name: "Compliance", exact: true }).click();
        await home.getByRole("tab", { name: "Screening" }).click();
        await expect(home.getByRole("button", { name: "Open Clients" })).toBeVisible();
      }
      if (role === "teller") {
        await page.locator('#phonebar [data-phone-app="more"]').click();
        const labels = await page.locator("#phone-more [data-phone-app]").evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-phone-app"))
        );
        expect(labels).toContain("compliance");
        expect(labels).not.toContain("dashboard");
        expect(labels).not.toContain("settings");
        expect(labels).not.toContain("reports");
      }
    }
  }
});

test("a failed filings load offers a retry and no stale zero", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.route("**/api/ledger/report-filings**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' })
  );
  await openCompliance(page);
  const shell = page.locator('[data-phone-shell][data-app="compliance"]');
  const home = shell.getByTestId("compliance-phone-home");
  await expect(home.getByTestId("compliance-error")).toContainText("Could not load compliance counts");
  const retry = shell.locator(".phone-sticky-btn");
  await expect(retry).toHaveText("Try again");
  const height = await retry.evaluate((el) => getComputedStyle(el).height);
  expect(height).toBe("48px");
  await expect(home.getByText("Not loaded").first()).toBeVisible();
  await expect(home.getByTestId("sanctions-screening-tile")).toHaveCount(0);
  const values = await home.locator(".phone-stat-value").allInnerTexts();
  expect(values).toEqual(["Not loaded", "Not loaded"]);
  await expect(shell.locator(".phone-fab, #phone-fab")).toHaveCount(0);
  await sweepCompliance(page);
  await shot(page, "error");
});

test("counts stay blank while filings are loading", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.route("**/api/ledger/report-filings**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 20000));
    await route.continue();
  });
  await openCompliance(page);
  const loading = page.getByTestId("compliance-loading");
  await expect(loading).toBeVisible();
  expect(await loading.innerText()).not.toMatch(/\d/);
  await sweepCompliance(page);
  await expect(loading).toBeVisible();
  await shot(page, "loading");
});

test("each phone detail is a list, and the filing form stays on a computer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await openCompliance(page);
  const shell = page.locator('[data-phone-shell][data-app="compliance"]');
  const home = shell.getByTestId("compliance-phone-home");
  await expect(home).toHaveAttribute("data-state", "ready");
  await sweepCompliance(page);

  const openDetail = async (name: RegExp, testId: string, heading: string) => {
    await home.getByRole("button", { name }).click();
    const detail = shell.getByTestId(testId);
    await expect(detail).toBeVisible();
    await expect(shell.locator("h1")).toHaveText(heading);
    await expect(shell.locator(".fld-tab")).toHaveCount(0);
    await expect(shell.getByText("Open worksheet")).toHaveCount(0);
    expect(await shell.innerText()).not.toMatch(/\$/);
    await expect(shell.locator(".phone-sticky-btn")).toHaveCount(0);
    await expect(page.locator("#phone-fab")).toHaveCount(0);
    await sweepCompliance(page);
    return detail;
  };

  await openDetail(/Reportable/, "compliance-detail-filings", "What you would file");
  await shot(page, "detail_filings");
  const formButton = shell.getByRole("button", { name: "Open this on a computer" });
  if (await formButton.count()) await formButton.click();
  else await shell.getByTestId("compliance-detail-filings").locator(".phone-row").first().click();
  await expect(shell.getByTestId("compliance-open-computer")).toContainText("Open this on a computer");
  await expect(shell.getByText("field by field")).toBeVisible();
  expect(await shell.innerText()).not.toMatch(/\$/);
  await sweepCompliance(page);
  await shot(page, "detail_form");
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(shell.getByTestId("compliance-detail-filings")).toBeVisible();
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(home).toBeVisible();

  await openDetail(/Structuring/, "compliance-detail-structuring", "Possible split deals");
  await shot(page, "detail_structuring");
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(home).toBeVisible();

  await home.getByRole("tab", { name: "24-hour rule" }).click();
  await openDetail(/Large cash/, "compliance-detail-aggregation", "24-hour rule");
  await shot(page, "detail_aggregation");
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(home).toBeVisible();

  await home.getByRole("tab", { name: "24-hour rule" }).click();
  await openDetail(/Clients missing ID/, "compliance-detail-missing", "Clients missing ID");
  await shot(page, "detail_missing");
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(home).toBeVisible();

  await home.getByRole("tab", { name: "Screening" }).click();
  const screening = await openDetail(/Sanctions screening/, "compliance-not-connected", "Sanctions screening");
  await expect(screening).toContainText("Not connected");
  await expect(screening).toContainText("No list provider is connected yet");
  expect(await screening.innerText()).not.toMatch(/\d/);
  await shot(page, "not_connected");
});

test("fixture deals fill the phone details and one deal drill", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  const stamp = await installScreenshotFixtures(page);
  await openCompliance(page);
  const shell = page.locator('[data-phone-shell][data-app="compliance"]');
  const home = shell.getByTestId("compliance-phone-home");
  await expect(home).toHaveAttribute("data-state", "ready");

  const openDetail = async (name: RegExp, testId: string, heading: string) => {
    await home.getByRole("button", { name }).click();
    const detail = shell.getByTestId(testId);
    await expect(detail).toBeVisible();
    await expect(shell.locator("h1")).toHaveText(heading);
    await expect(shell.locator(".fld-tab")).toHaveCount(0);
    await expect(shell.getByText("Open worksheet")).toHaveCount(0);
    expect(await shell.innerText()).not.toMatch(/\$/);
    expect(await shell.innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    await expect(shell.locator(".phone-sticky-btn")).toHaveCount(0);
    await expect(page.locator("#phone-fab")).toHaveCount(0);
    await sweepCompliance(page);
    return detail;
  };

  const filings = await openDetail(/Reportable/, "compliance-detail-filings", "What you would file");
  await expect(filings.getByRole("button", { name: /Amina Farah/ })).toContainText("10,000.00 CAD");
  await expect(filings.getByRole("button", { name: /Amina Farah/ })).toContainText("Large cash");
  await expect(filings.getByRole("button", { name: /Amina Farah/ })).toContainText(stamp.row);
  await expect(filings.getByRole("button", { name: /Leah Cho/ })).toContainText("10,300.00 CAD");
  await expect(filings.getByRole("button", { name: /Noah Pell/ })).toContainText("10,200.00 CAD");
  await expect(filings).toContainText("You file");
  await page.setViewportSize({ width: 360, height: 780 });
  await expectRowsFit(filings);
  await shot(page, "detail_filings_filled");
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(home).toBeVisible();

  const splits = await openDetail(/Structuring/, "compliance-detail-structuring", "Possible split deals");
  await expect(splits.getByRole("button", { name: /Noah Pell/ })).toContainText("3 just-under");
  await expect(splits.getByRole("button", { name: /Noah Pell/ })).toContainText("10,200.00 CAD");
  await expect(splits.getByRole("button", { name: /Noah Pell/ })).toContainText("Warnings only");
  await expect(splits.getByRole("button", { name: /Leah Cho/ })).toContainText("2 just-under");
  await page.setViewportSize({ width: 360, height: 780 });
  await expectRowsFit(splits);
  await shot(page, "detail_structuring_filled");
  await splits.getByRole("button", { name: /Noah Pell/ }).click();
  const deals = shell.getByTestId("compliance-detail-deals");
  await expect(deals).toBeVisible();
  await expect(shell.locator("h1")).toHaveText("Noah Pell");
  await expect(shell.locator(".phone-title p")).toHaveText("3 deals today, 10,200.00 CAD together");
  await expect(deals.getByText("Warnings only. The desk does not stop the deal.")).toHaveCount(1);
  await expect(deals).toContainText(stamp.heading);
  await expect(deals).toContainText("3,200.00 CAD");
  await expect(deals).toContainText("3,400.00 CAD");
  await expect(deals).toContainText("3,600.00 CAD");
  await expect(deals).toContainText("10:15 AM");
  await expect(deals).toContainText("1:40 PM");
  await expect(deals).toContainText("5:05 PM");
  expect(await deals.innerText()).not.toMatch(/\b(?:am|pm)\b/);
  expect(await shell.innerText()).not.toMatch(/\$/);
  await expect(shell.locator(".fld-tab")).toHaveCount(0);
  await sweepCompliance(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await expectRowsFit(deals);
  await shot(page, "detail_deals");
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(shell.getByTestId("compliance-detail-structuring")).toBeVisible();
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(home).toBeVisible();

  await home.getByRole("tab", { name: "24-hour rule" }).click();
  const aggregate = await openDetail(/Large cash/, "compliance-detail-aggregation", "24-hour rule");
  await expect(shell.locator(".phone-title p")).toContainText("Cash from one client within 24 hours adds up.");
  await expect(shell.locator(".phone-title p")).toContainText("At 10,000.00 CAD or more, you file.");
  expect(await shell.innerText()).not.toMatch(/24h|static window/i);
  await expect(aggregate.getByRole("button", { name: /Leah Cho/ })).toContainText("2 cash-ins");
  await expect(aggregate.getByRole("button", { name: /Leah Cho/ })).toContainText("10,300.00 CAD");
  await expect(aggregate.getByRole("button", { name: /Leah Cho/ })).toContainText("Today");
  await expect(aggregate.getByRole("button", { name: /Noah Pell/ })).toContainText("3 cash-ins");
  await expect(aggregate.getByRole("button", { name: /Noah Pell/ })).toContainText("10,200.00 CAD");
  await page.setViewportSize({ width: 360, height: 780 });
  await expectRowsFit(aggregate);
  await shot(page, "detail_aggregation_filled");
  await shell.getByRole("button", { name: "Compliance", exact: true }).click();
  await expect(home).toBeVisible();

  await home.getByRole("tab", { name: "24-hour rule" }).click();
  const missing = await openDetail(/Clients missing ID/, "compliance-detail-missing", "Clients missing ID");
  await expect(missing.getByRole("button", { name: /Sam Idris/ })).toContainText("missing ID");
  await expect(missing).not.toContainText("Amina Farah");
  await expect(missing).not.toContainText("Noah Pell");
  await expect(missing).not.toContainText("Leah Cho");
  await page.setViewportSize({ width: 360, height: 780 });
  await expectRowsFit(missing);
  await shot(page, "detail_missing_filled");
});

/* Two cash deals, neither one at the line, totalling exactly 10,000.00 CAD.
   Canada files at the line, so this set is a report. The sentence and the
   badge both come from that pack, not from a fixed "over 10,000". */
test("a set totalling exactly 10,000.00 CAD shows You file", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  const day = await page.evaluate(() => String(window.CDOS.businessDate()).slice(0, 10));
  await page.evaluate((businessDay) => {
    const cash = (id: string, ref: string, time: string, amount: number) => ({
      id,
      ref,
      date: businessDay,
      time,
      customer: "Rita Okonkwo",
      beneficiary: "",
      type: "Currency Exchange",
      inCcy: "CAD",
      inAmt: amount,
      outCcy: "USD",
      outAmt: 1,
      status: "posted",
      filed: false,
      ackStr: false,
      voidReason: "",
      voidBy: "",
      voidAt: "",
    });
    localStorage.setItem("cdos_rows_v1", JSON.stringify([
      cash("fx-exact-a", "LT-EXACT-A", "09:00", 5000),
      cash("fx-exact-b", "LT-EXACT-B", "15:00", 5000),
    ]));
    localStorage.setItem("cdos_clients_v1", JSON.stringify({
      "Rita Okonkwo": { idType: "Passport", idNum: "P400004", idExpiry: "2030-06-01" },
    }));
  }, day);
  await page.reload({ waitUntil: "domcontentloaded" });
  await landOnDesktop(page);
  await dismissTour(page);
  await settled(page);
  await openCompliance(page);
  const shell = page.locator('[data-phone-shell][data-app="compliance"]');
  const home = shell.getByTestId("compliance-phone-home");
  await expect(home).toHaveAttribute("data-state", "ready");
  await home.getByRole("tab", { name: "24-hour rule" }).click();
  await home.getByRole("button", { name: /Large cash/ }).click();
  await expect(shell.locator("h1")).toHaveText("24-hour rule");
  await expect(shell.locator(".phone-title p")).toHaveText("Cash from one client within 24 hours adds up. At 10,000.00 CAD or more, you file.");
  const row = shell.getByRole("button", { name: /Rita Okonkwo/ });
  await expect(row).toContainText("10,000.00 CAD");
  await expect(row).toContainText("You file");
  expect(await shell.innerText()).not.toMatch(/\bOver\b/);
});
