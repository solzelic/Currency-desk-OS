/* Phone Reports. At 360 and 390 the close-of-day screen is the phone
   one. At 1280 the desk launcher is the one a wide window already had,
   and a trip down to a phone and back does not move a pixel of it. */
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const SHOTS = "/opt/cursor/artifacts/screenshots";
const WIDTHS = [360, 390] as const;

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

async function openReports(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator("#phone-more")).toBeVisible();
  await page.locator('#phone-more [data-phone-app="reports"]').click();
  await dismissTour(page);
  await settled(page);
  await expect(page.locator("[data-reports-home]")).toBeVisible();
  await expect(page.locator('#phonebar [data-phone-app="more"]')).toHaveClass(/is-on/);
}

/* Both choices sit in the viewport, and the tab bar does not
   cover either centre. */
async function expectClearOfTheBar(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  const box = await button.boundingBox();
  if (!box) throw new Error(name + " has no box");
  const view = page.viewportSize();
  if (!view) throw new Error("no viewport");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 1);
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return "nothing";
    const bar = el.closest("#appbar, #phone-dock, #phonebar");
    if (bar) return "covered";
    const control = el.closest("button");
    return control ? (control.textContent || "").replace(/\s+/g, " ").trim() : "not a button";
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  expect(hit).toBe(name);
}

/* The note sits under the title, across the text column, and the
   count stays on the right. A clipped note fails this. */
async function expectCheckNote(sheet: ReturnType<Page["locator"]>): Promise<void> {
  const row = sheet.locator(".phone-row", { hasText: "Clients missing ID" });
  const note = row.locator(".phone-row-sub");
  const title = row.locator(".phone-row-title");
  const amount = row.locator(".phone-row-amt");
  await expect(note).toHaveText("Clients who dealt today");
  const fit = await note.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth + 1,
    text: el.textContent || "",
  }));
  expect(fit.clipped, fit.text).toBe(false);
  const noteBox = await note.boundingBox();
  const titleBox = await title.boundingBox();
  const amountBox = await amount.boundingBox();
  const rowBox = await row.boundingBox();
  if (!noteBox || !titleBox || !amountBox || !rowBox) throw new Error("the check row has no box");
  expect(noteBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
  expect(noteBox.x).toBeGreaterThanOrEqual(rowBox.x);
  expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  expect(amountBox.x).toBeGreaterThan(titleBox.x);
}

/* One posted deal, through the desk's own quote. The live seed is
   not touched. A fresh till has no stock, so the spec tops the
   drawer up first, the same way a bank drop would. */
async function postFixtureDeal(page: Page): Promise<{
  posted: number; home: string; volume: string; earnings: string; fees: string; realized: boolean; currencies: string[];
}> {
  const result = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session", { credentials: "same-origin" }).then((r) => r.json());
    if (!(current.session && current.session.status === "open")) {
      const opened = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (!opened.ok && opened.status !== 409) return { ok: false as const, why: "till did not open: " + opened.status + " " + await opened.text() };
    }
    const topUp = async (currency: string, amount: string) => {
      const answer = await fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          idempotencyKey: "rpt-topup-" + currency + "-" + Date.now(),
          direction: "in",
          currency,
          amount,
          counterpartyType: "bank",
          counterpartyRef: "reports-spec",
          reason: "Fixture so phone Reports can show a day with deals",
        }),
      });
      return answer.ok ? "" : currency + " " + answer.status + " " + await answer.text();
    };
    const topped = [await topUp("USD", "500.00"), await topUp("CAD", "500.00")].filter(Boolean);
    if (topped.length) return { ok: false as const, why: topped.join(" · ") };
    const made = await fetch("/api/ledger/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        externalRef: "rpt-" + Date.now(),
        name: "Reports Fixture",
        risk: "normal",
        idStatus: "verified",
      }),
    });
    const customer = await made.json().catch(() => ({}));
    if (!made.ok || !customer.customerId) return { ok: false as const, why: "no customer: " + made.status + " " + JSON.stringify(customer) };
    const attempts = [
      { from: "CAD", to: "USD", inputAmount: "200.00", direction: "customer_buy_foreign" },
      { from: "USD", to: "CAD", inputAmount: "100.00", direction: "customer_sell_foreign" },
    ];
    const refused: string[] = [];
    for (const attempt of attempts) {
      const quote = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ customerId: customer.customerId, feeCad: "5.00", ...attempt }),
      });
      if (!quote.ok) { refused.push("quote " + attempt.from + ": " + quote.status + " " + await quote.text()); continue; }
      const frozen = await quote.json();
      const posted = await fetch("/api/quotes/" + frozen.quoteId + "/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          idempotencyKey: "rpt-deal-" + Date.now(),
          purpose: "Personal travel",
          sourceOfFunds: "Employment income",
        }),
      });
      if (!posted.ok) { refused.push("post " + attempt.from + ": " + posted.status + " " + await posted.text()); continue; }
      const answer = await window.CDOS.Backend.loadCloseOfDay();
      const snap = (answer.signoff && answer.signoff.snapshot) || answer.preview;
      if (!snap) return { ok: false as const, why: "close of day returned no snapshot" };
      return {
        ok: true as const,
        posted: Number(snap.posted),
        home: String(snap.homeCurrency || "CAD"),
        volume: snap.volumeHome == null ? "" : String(snap.volumeHome),
        earnings: snap.earningsHome == null ? "" : String(snap.earningsHome),
        fees: snap.feesHome == null ? "" : String(snap.feesHome),
        realized: snap.realizedPnlHome != null,
        currencies: (snap.volumeByCurrency || []).map((row: { currency: string; amount: string }) => row.currency + " " + row.amount),
      };
    }
    return { ok: false as const, why: refused.join(" · ") };
  });
  expect(result.ok, "why" in result ? result.why : "").toBe(true);
  if (!result.ok) throw new Error(result.why);
  expect(result.posted).toBeGreaterThan(0);
  expect(result.volume).not.toBe("");
  return {
    posted: result.posted,
    home: result.home,
    volume: result.volume,
    earnings: result.earnings,
    fees: result.fees,
    realized: result.realized,
    currencies: result.currencies,
  };
}

function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: `${SHOTS}/${name}.png` }).then(() => undefined);
}

/* Two screenshots of the same node, compared in the page so the suite
   does not take a second image library. A difference of 0 is the bar. */
async function pixelDiff(page: Page, left: Buffer, right: Buffer): Promise<number> {
  return page.evaluate(async ({ a, b }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("screenshot could not be read"));
      img.src = src;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return -1;
    const canvas = document.createElement("canvas");
    canvas.width = ia.width;
    canvas.height = ia.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas is not available");
    ctx.drawImage(ia, 0, 0);
    const da = ctx.getImageData(0, 0, ia.width, ia.height).data;
    ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, ia.width, ia.height).data;
    let diff = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) diff += 1;
    }
    return diff;
  }, { a: `data:image/png;base64,${left.toString("base64")}`, b: `data:image/png;base64,${right.toString("base64")}` });
}

test("the home shows the book's figures, and a cashier sees two reports", async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await atDesk(page, "j.masri");
    /* The seed till is not opened. The date and the figures are the
       session's, so the day has to be open before the home can show them. */
    await page.evaluate(async () => {
      const current = await fetch("/api/ledger/till-session", { credentials: "same-origin" }).then((r) => r.json());
      if (current.session && current.session.status === "open") return;
      const opened = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (!opened.ok && opened.status !== 409) throw new Error("till did not open: " + opened.status + " " + await opened.text());
    });
    await openReports(page);
    const summary = await page.evaluate(async () => {
      const answer = await window.CDOS.Backend.loadCloseOfDay();
      return (answer.signoff && answer.signoff.snapshot) || answer.preview || {};
    });
    const home = page.locator("[data-reports-home]");
    await expect(home.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(home.getByText("Today's end of day")).toBeVisible();
    await expect(home).toContainText(/\w{3} \d{1,2}, \d{4}/);
    const deals = home.locator(".stat").nth(0);
    await expect(deals).toContainText("Deals");
    await expect(deals).toContainText(String(summary.posted));
    const taken = home.locator(".stat").nth(1);
    if (summary.posted === 0) {
      const homeCcy = summary.homeCurrency || "CAD";
      await expect(taken).toContainText("0.00");
      await expect(taken).toContainText(homeCcy);
      await expect(taken).toContainText("No deals yet");
      await expect(taken).not.toContainText("Nothing taken in yet");
      await expect(home.locator(".stat").nth(2)).toContainText("No deals yet");
      await expect(home.locator(".stat").nth(3)).toContainText("Not counted yet");
      await shot(page, `reports_home_empty_${width}`);
    } else if (summary.volumeHome != null) {
      const formatted = new Intl.NumberFormat("en-CA", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(summary.volumeHome));
      await expect(taken).toContainText(formatted);
      await expect(taken).toContainText(summary.homeCurrency);
      await expect(taken).toContainText("in " + summary.homeCurrency);
    } else {
      await expect(taken).toContainText(/Not loaded|No rate for/);
    }
    if (summary.earningsHome != null) {
      await expect(home.locator(".stat").nth(2)).toContainText(summary.homeCurrency);
    }
    const text = await home.innerText();
    expect(text).not.toContain("Example data");
    expect(text).not.toMatch(/\$/);
    await expect(home.getByRole("button", { name: "All deals" })).toBeVisible();
    await expect(home.getByRole("button", { name: "Large cash report" })).toBeVisible();
    await expect(home.getByText("Deals of 10,000 CAD or more")).toBeVisible();
    await expect(home.getByText("You file")).toHaveCount(0);
    await expect(home.getByRole("button", { name: "Large cash pack" })).toHaveCount(0);
    await expect(home.getByText("Ask an owner for other reports")).toHaveCount(0);
    await expect(page.locator("[data-reports-save] button")).toHaveText("Save today's end of day");
    await expect(page.locator("[data-phone-reports]")).not.toContainText("PDF");

    const before = await page.evaluate(() => localStorage.getItem("cdos_report_history_v1"));
    await home.getByRole("button", { name: "See the full sheet" }).click();
    const sheet = page.locator("[data-reports-sheet]");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Single deals of");
    await expect(sheet).toContainText("LCTR, 24-hour total");
    const named = await page.evaluate(() => {
      const station = JSON.parse(localStorage.getItem("cdos_station_v1") || "null");
      const branches = JSON.parse(localStorage.getItem("cdos_stations_v2") || "null") || [];
      const branch = station && branches.find((b: { id: string }) => b.id === station.branchId);
      const till = branch && (branch.tills || []).find((t: { id: string }) => t.id === station.tillId);
      const name = till && till.name ? String(till.name).replace(/\s+—.*/, "").trim() : "";
      return { id: station && station.tillId, name };
    });
    if (named.name) await expect(sheet).toContainText(named.name);
    if (named.id) await expect(sheet).not.toContainText(named.id);
    const row = sheet.locator(".phone-row").first();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    if (!box) throw new Error("the drawer row has no box");
    expect(box.height).toBeGreaterThanOrEqual(56);
    expect(box.height).toBeLessThan(88);
    const largeTile = sheet.locator(".stat", { hasText: "Large cash deals" });
    await expect(largeTile).toContainText("10,000 CAD or more");
    await expect(largeTile).not.toContainText(".00");
    const saveBtn = page.locator("[data-reports-save] button");
    await expect(saveBtn).toHaveText("Save end of day");
    await expect(saveBtn).toBeEnabled();
    const face = await saveBtn.evaluate((el) => {
      const style = getComputedStyle(el);
      return { transform: style.textTransform, spacing: style.letterSpacing, family: style.fontFamily };
    });
    expect(face.transform).not.toBe("uppercase");
    expect(face.spacing === "normal" || face.spacing === "0px").toBe(true);
    const regulator = await page.evaluate(() => {
      const pack = window.CDOS.deskPack && window.CDOS.deskPack();
      return pack && pack.regulator ? String(pack.regulator).trim() : "";
    });
    expect(regulator.length).toBeGreaterThan(0);
    await expect(page.getByText(`Kept in Saved reports. Not sent to ${regulator}.`)).toBeVisible();
    await expect(sheet).not.toContainText("PDF");
    await expectCheckNote(sheet);
    const afterOpen = await page.evaluate(() => localStorage.getItem("cdos_report_history_v1"));
    expect(afterOpen).toBe(before);
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(page.locator("[data-reports-home]")).toBeVisible();

    await page.locator(".phone-head .mb-acct").click();
    await page.getByRole("button", { name: /M\. Costa/ }).click();
    await page.keyboard.type("0000");
    await expect(page.locator(".phone-head .mb-acct-av")).toHaveText("MC");
    /* Switching person closes Reports. The cashier cannot open it again. */
    await expect(page.locator("[data-phone-reports]")).toHaveCount(0);
    await page.locator('#phonebar [data-phone-app="more"]').click();
    await expect(page.locator("#phone-more")).toBeVisible();
    await expect(page.locator('#phone-more [data-phone-app="reports"]')).toHaveCount(0);
    await shot(page, `reports_home_teller_${width}`);
  }
});

test("a day with deals shows the figures on the home and the sheet", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 360, height: 780 });
  await atDesk(page, "j.masri");
  const book = await postFixtureDeal(page);
  const formatted = new Intl.NumberFormat("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(book.volume));
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    if (width === WIDTHS[0]) await openReports(page);
    await expect(page.locator("[data-phone-reports]")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    const home = page.locator("[data-reports-home]");
    await expect(home).toBeVisible();
    const taken = home.locator(".stat").nth(1);
    await expect(home.locator(".stat").nth(0)).toContainText(String(book.posted));
    await expect(taken).toContainText(formatted);
    await expect(taken).toContainText(book.home);
    await expect(taken).toContainText("in " + book.home);
    for (const line of book.currencies) {
      const code = line.slice(0, 3);
      await expect(taken).toContainText(code);
    }
    if (book.realized) {
      await expect(home.locator(".stat").nth(2)).toContainText("Fees + margin");
      expect(book.earnings).not.toBe(book.fees);
    }
    await expect(taken).not.toContainText("No deals yet");
    await expect(taken).not.toContainText("Nothing taken in yet");
    await shot(page, `reports_home_owner_${width}`);
    await home.getByRole("button", { name: "See the full sheet" }).click();
    const sheet = page.locator("[data-reports-sheet]");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".stat").nth(1)).toContainText(formatted);
    await expectCheckNote(sheet);
    await shot(page, `reports_sheet_${width}`);
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(home).toBeVisible();
  }
});

test("an uncounted drawer asks first, and a double tap saves once", async ({ page }) => {
  test.setTimeout(180_000);
  let popups = 0;
  page.on("popup", () => { popups += 1; });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await atDesk(page, "j.masri");
    await page.evaluate(async () => {
      const tillId = "till-rpt-" + Date.now();
      const response = await fetch("/api/desk/branches/br-yorkville/tills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ tillId }),
      });
      const body = await response.json().catch(() => ({}));
      const id = body.workspaceId || (body.till && body.till.workspaceId);
      if (!id) throw new Error("fresh till was not created: " + response.status + " " + JSON.stringify(body));
      await window.CDOS.Backend.selectWorkspace(id);
      window.CDOS.Backend.setWorkspace(id);
      const opened = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (!opened.ok && opened.status !== 409) throw new Error("till did not open: " + opened.status + " " + await opened.text());
    });
    await openReports(page);
    await expect(page.locator("[data-reports-home]")).toContainText("Not counted yet");
    const offered = page.locator("[data-reports-save] button");
    await expect(offered).toBeEnabled();
    await expect(offered).toHaveText("Save today's end of day");
    await page.getByRole("button", { name: "See the full sheet" }).click();
    const closeSheet = page.locator("[data-reports-sheet]");
    await expect(closeSheet).toContainText("Drawer at close · Not counted yet");
    await closeSheet.getByRole("button", { name: "Count now" }).click();
    await dismissTour(page);
    await expect(page.getByRole("button", { name: "Save count" })).toBeVisible();
    await page.locator('#phonebar [data-phone-app="more"]').click();
    await page.locator('#phone-more [data-phone-app="reports"]').click();
    await dismissTour(page);
    await expect(page.locator("[data-reports-sheet]")).toBeVisible();
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(page.locator("[data-phone-reports]")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await expect(page.locator("[data-reports-home]")).toContainText("Not counted yet");
    await page.evaluate(() => {
      window.__opens = 0;
      window.__prints = 0;
      window.open = () => { window.__opens += 1; return null; };
      window.print = () => { window.__prints += 1; };
      localStorage.removeItem("cdos_report_history_v1");
    });
    await page.locator("[data-reports-save]").click();
    const cover = page.locator("[data-reports-uncounted]");
    const choice = page.getByRole("dialog", { name: "The drawer is not counted yet" });
    await expect(cover).toBeVisible();
    await expect(choice).toBeVisible();
    await expect(cover).toContainText("The drawer is not counted yet");
    await expect(choice.getByRole("button", { name: "Count the drawer" })).toBeVisible();
    await expect(choice.getByRole("button", { name: "Save without a count" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    const choiceBox = await choice.boundingBox();
    const homeTitle = await page.getByRole("heading", { name: "Reports", exact: true }).boundingBox();
    if (!choiceBox || !homeTitle) throw new Error("the count sheet has no box");
    expect(choiceBox.y).toBeGreaterThan(homeTitle.y + homeTitle.height);
    const scrim = await cover.evaluate((el) => getComputedStyle(el).backgroundColor);
    const channels = scrim.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/)
      || scrim.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\)/);
    if (!channels) throw new Error("scrim colour was " + scrim);
    const modern = scrim.startsWith("color(");
    const red = Number(channels[1]) * (modern ? 255 : 1);
    const green = Number(channels[2]) * (modern ? 255 : 1);
    const blue = Number(channels[3]) * (modern ? 255 : 1);
    const alpha = channels[4] == null ? 1 : Number(channels[4]);
    expect(Math.abs(red - 22)).toBeLessThan(0.6);
    expect(Math.abs(green - 21)).toBeLessThan(0.6);
    expect(Math.abs(blue - 19)).toBeLessThan(0.6);
    expect(Math.abs(alpha - 0.4)).toBeLessThan(0.02);
    await expectClearOfTheBar(page, "Count the drawer");
    await expectClearOfTheBar(page, "Save without a count");
    await shot(page, `reports_not_counted_${width}`);
    const view = page.viewportSize();
    if (!view) throw new Error("no viewport");
    /* The scrim covers the tab bar. The tap closes the sheet and does not switch tabs. */
    await page.mouse.click(view.width / 2, view.height - 8);
    await expect(page.locator("[data-phone-reports]")).toBeVisible();
    await expect(page.locator("#phone-more")).toBeHidden();
    await expect(choice).toBeHidden();
    await page.locator("[data-reports-save]").click();
    await expect(choice).toBeVisible();
    await page.mouse.click(choiceBox.x + choiceBox.width / 2, homeTitle.y + homeTitle.height + 24);
    await expect(choice).toBeHidden();
    await expect(page.locator("[data-reports-home]")).toBeVisible();
    await expect(page.locator("[data-reports-save] button")).toBeEnabled();
    await page.locator("[data-reports-save]").click();
    await expect(choice).toBeVisible();
    const again = await choice.boundingBox();
    if (!again) throw new Error("the count sheet did not reopen");
    await page.mouse.move(again.x + again.width / 2, again.y + 16);
    await page.mouse.down();
    await page.mouse.move(again.x + again.width / 2, again.y + 140, { steps: 8 });
    await page.mouse.up();
    await expect(choice).toBeHidden();
    await page.locator("[data-reports-save]").click();
    await expect(choice).toBeVisible();
    let posts = 0;
    const countPosts = (req: { method(): string; url(): string }) => {
      if (req.method() === "POST" && req.url().includes("/api/ledger/close-of-day")) posts += 1;
    };
    page.on("request", countPosts);
    /* Both clicks run in one turn, before React can disable the button.
       A real mouse click is the next test. Removing the lock posts twice. */
    await page.evaluate(() => {
      const button = document.querySelector("[data-reports-uncounted] .btn-secondary");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Save without a count is not on the screen");
      button.click();
      button.click();
    });
    await expect.poll(() => posts).toBe(1);
    page.off("request", countPosts);
    await expect(page.locator("[data-reports-toast]")).toBeVisible();
    const saved = await page.evaluate(() => {
      const hist = JSON.parse(localStorage.getItem("cdos_report_history_v1") || "[]");
      const entry = hist[0] || {};
      return { n: hist.length, at: entry.at || "", opens: window.__opens, prints: window.__prints, html: (document.getElementById("phone-rep-print") || {}).innerHTML || "" };
    });
    expect(saved.n).toBe(1);
    expect(saved.at).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    const formatted = await page.evaluate(() => window.CDOS.formatPhoneTime("15:02"));
    expect(formatted).toBe("3:02 PM");
    expect(saved.opens).toBe(0);
    expect(saved.prints).toBe(1);
    const regulator = await page.evaluate(() => {
      const pack = window.CDOS.deskPack && window.CDOS.deskPack();
      return pack && pack.regulator ? String(pack.regulator).trim() : "";
    });
    expect(regulator.length).toBeGreaterThan(0);
    expect(saved.html).toContain("Not counted");
    expect(saved.html).toContain("No deals yet");
    expect(saved.html).not.toContain("Nothing taken in yet");
    expect(saved.html).toContain(`Kept in Saved reports. Not sent to ${regulator}.`);
    expect(saved.html).not.toContain("PDF");
    expect(saved.html).toContain("Single deals of");
    expect(saved.html).toContain("LCTR, 24-hour total");
    expect(saved.html).toContain("Teller");
    expect(saved.html).toContain("Owner");
    expect(saved.html.indexOf("Owner")).toBeGreaterThan(saved.html.indexOf("Teller"));
    expect(saved.html).not.toMatch(/Teller[^<]*Owner/);
    const toast = page.locator("[data-reports-toast]");
    await expect(toast).toContainText("End of day saved. Find it in Saved reports.");
    await expect(toast).toHaveAttribute("role", "status");
    const toastBox = await toast.boundingBox();
    const titleBox = await page.getByRole("heading", { name: "Reports", exact: true }).boundingBox();
    const saveBox = await page.locator("[data-reports-save]").boundingBox();
    if (!toastBox || !titleBox || !saveBox) throw new Error("the saved note has no box");
    expect(toastBox.y).toBeGreaterThan(titleBox.y + titleBox.height);
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(saveBox.y - 12);
    expect(saveBox.y - (toastBox.y + toastBox.height)).toBeLessThanOrEqual(20);
    expect(toastBox.x).toBeGreaterThanOrEqual(15);
    expect(toastBox.x).toBeLessThanOrEqual(17);
    const viewFace = await toast.getByRole("button", { name: "View" }).evaluate((el) => {
      const style = getComputedStyle(el);
      return { bg: style.backgroundColor, weight: style.fontWeight, color: style.color };
    });
    expect(viewFace.bg === "rgba(0, 0, 0, 0)" || viewFace.bg === "transparent").toBe(true);
    expect(viewFace.weight).toBe("600");
    expect(viewFace.color).toBe("rgb(255, 255, 255)");
    await shot(page, `reports_toast_${width}`);
    await toast.getByRole("button", { name: "View" }).click();
    await expect(page.getByRole("heading", { name: "Saved reports" })).toBeVisible();
  }
  expect(popups).toBe(0);
});

test("a slow book shows the waking banner in the real layout", async ({ page }) => {
  test.setTimeout(120_000);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await atDesk(page, "j.masri");
    await page.route("**/api/ledger/summary**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.continue();
    });
    await page.locator('#phonebar [data-phone-app="more"]').click();
    await page.locator('#phone-more [data-phone-app="reports"]').click();
    await dismissTour(page);
    await expect(page.getByText("Waking the server")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("This can take up to a minute. Keep this screen open.")).toBeVisible();
    await expect(page.locator("[data-reports-save] button")).toBeDisabled();
    await expect(page.getByText("Ready once today's figures load.")).toBeVisible();
    await expect(page.locator("[data-phone-reports]")).toHaveAttribute("data-state", "loading");
    await shot(page, `reports_loading_${width}`);
    await page.unroute("**/api/ledger/summary**");
  }
});

test("the reports home passes the phone sweep", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  /* A shared till may already be counted. The cover is part of this
     sweep, so the desk is a till that has never been counted. */
  await page.evaluate(async () => {
    const tillId = "till-sweep-" + Date.now();
    const response = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tillId }),
    });
    const body = await response.json().catch(() => ({}));
    const id = body.workspaceId || (body.till && body.till.workspaceId);
    if (!id) throw new Error("fresh till was not created: " + response.status + " " + JSON.stringify(body));
    await window.CDOS.Backend.selectWorkspace(id);
    window.CDOS.Backend.setWorkspace(id);
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (!opened.ok && opened.status !== 409) throw new Error("till did not open: " + opened.status);
  });
  await openReports(page);
  await phoneSweep(page, { roots: ["[data-phone-reports]"] });
  await page.getByRole("button", { name: "See the full sheet" }).click();
  await expect(page.locator("[data-reports-sheet]")).toBeVisible();
  await phoneSweep(page, { roots: ["[data-phone-reports]"] });
  await page.locator("[data-reports-save]").click();
  await expect(page.locator("[data-reports-uncounted]")).toBeVisible();
  await phoneSweep(page, { roots: ["[data-phone-reports]"] });
});

test("a failed read says so and keeps the button off", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.route("**/api/ledger/summary**", (route) => route.abort());
  await openReports(page);
  await expect(page.getByText("Could not load today's figures. Check the connection and try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator("[data-reports-save] button")).toBeDisabled();
  await expect(page.locator("[data-phone-reports]")).toHaveAttribute("data-state", "error");
  await page.unroute("**/api/ledger/summary**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("[data-phone-reports]")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
});

test("the sign-off asks for the window the till session names", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  const from = "2020-01-02T05:00:00.000Z";
  const to = "2020-01-03T05:00:00.000Z";
  await page.route("**/api/ledger/till-session", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.day = { from, to, timeZone: "America/Toronto" };
    await route.fulfill({ response, json: body });
  });
  const summary = page.waitForRequest((req) => req.url().includes("/api/ledger/summary") && req.url().includes(encodeURIComponent(from)));
  await openReports(page);
  const req = await summary;
  const url = new URL(req.url());
  expect(url.searchParams.get("from")).toBe(from);
  expect(url.searchParams.get("to")).toBe(to);
  await page.unroute("**/api/ledger/till-session");
});

test("the desktop launcher is unchanged at 1280", async ({ page }) => {
  /* Two captures of the same launcher. A phone visit is not part of
     this check: the desk already clamps a window when the viewport
     shrinks and does not grow it back, so the stored size would
     change for every app, not just Reports. */
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page, "j.masri");
  await page.locator('#appbar [data-app="reports"]').click();
  await dismissTour(page);
  await settled(page);
  const body = page.locator(".win.show.active .win-body");
  await expect(body.getByText("End-of-Day Sign-Off")).toBeVisible();
  await expect(body.getByText("Save today's end of day")).toHaveCount(0);
  await expect(page.locator("[data-phone-reports]")).toHaveCount(0);
  await expect(page.locator("#phonebar")).toBeHidden();
  await expect(page.locator("#appbar")).toBeVisible();
  await shot(page, "reports_1280");
  await page.evaluate(() => {
    const node = document.querySelector(".win.show.active .win-body");
    if (node) node.scrollTop = 0;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const before = await body.screenshot();
  const after = await body.screenshot();
  const diff = await pixelDiff(page, before, after);
  expect(diff).toBe(0);
});

test("a till that was never opened has no save button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.evaluate(async () => {
    const tillId = "till-closed-" + Date.now();
    const response = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tillId }),
    });
    const body = await response.json().catch(() => ({}));
    const id = body.workspaceId || (body.till && body.till.workspaceId);
    if (!id) throw new Error("fresh till was not created: " + response.status);
    await window.CDOS.Backend.selectWorkspace(id);
    window.CDOS.Backend.setWorkspace(id);
  });
  await openReports(page);
  await expect(page.getByText("Open the till before saving the day.")).toBeVisible();
  await expect(page.locator("[data-reports-save]")).toHaveCount(0);
});

test("the count sheet's buttons take a mouse click", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.evaluate(async () => {
    const tillId = "till-mouse-" + Date.now();
    const response = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tillId }),
    });
    const body = await response.json().catch(() => ({}));
    const id = body.workspaceId || (body.till && body.till.workspaceId);
    if (!id) throw new Error("fresh till was not created");
    await window.CDOS.Backend.selectWorkspace(id);
    window.CDOS.Backend.setWorkspace(id);
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (!opened.ok && opened.status !== 409) throw new Error("till did not open");
  });
  await openReports(page);
  await page.locator("[data-reports-save]").click();
  const choice = page.getByRole("dialog", { name: "The drawer is not counted yet" });
  await expect(choice).toBeVisible();
  const count = choice.getByRole("button", { name: "Count the drawer" });
  const countBox = await count.boundingBox();
  if (!countBox) throw new Error("Count the drawer has no box");
  await page.mouse.click(countBox.x + countBox.width / 2, countBox.y + countBox.height / 2);
  await expect(page.getByRole("button", { name: "Save count" })).toBeVisible();
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="reports"]').click();
  await dismissTour(page);
  await page.locator("[data-reports-save]").click();
  await expect(choice).toBeVisible();
  const save = choice.getByRole("button", { name: "Save without a count" });
  const saveBox = await save.boundingBox();
  if (!saveBox) throw new Error("Save without a count has no box");
  await page.mouse.click(saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2);
  await expect(page.locator("[data-reports-toast]")).toContainText("End of day saved");
});

test("other phone reports use a 12-hour date, a currency code, and 44px chips", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install({ time: new Date("2026-10-12T18:30:00.000Z") });
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await openReports(page);
  await page.getByRole("button", { name: "All deals" }).click();
  const doc = page.locator("#cdos-phone-doc");
  await expect(doc).toContainText("Oct 12, 2026, 2:30 PM");
  await expect(doc).not.toContainText("$");
  const chip = page.locator(".phone-reports .chip").first();
  const box = await chip.boundingBox();
  if (!box) throw new Error("the chip has no box");
  expect(box.height).toBeGreaterThanOrEqual(44);
  await phoneSweep(page, { roots: ["[data-phone-reports]"] });
});
