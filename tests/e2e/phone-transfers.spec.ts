/* Phone Transfers. 360 and 390 are the cashier's phone. 1280 must
   stay the desktop pipeline. The foundation owns the 1280 picture.

   A transfer is posted through the screen, then the ledger is asked
   what moved. A double tap is one post. Status changes on the detail
   sheet, by hand: nothing here calls a partner. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = process.env.PHONE_SHOTS || path.join(process.cwd(), "shots/phone-transfers");
mkdirSync(SHOTS, { recursive: true });

const OPENING = { CAD: "25000.00", USD: "12000.00" };

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

/* The window fades in. A shot during that fade is a grey wash.
   Reduced motion drops the transition. This still checks the paint:
   every ancestor of the list is fully opaque, and More is gone. */
async function waitOpaque(page: Page): Promise<void> {
  const root = page.locator('[data-phone="transfers"]');
  await expect(root).toBeVisible();
  await expect.poll(async () => root.evaluate((node) => {
    let min = 1;
    let el: HTMLElement | null = node as HTMLElement;
    while (el) {
      const opacity = Number(getComputedStyle(el).opacity);
      if (Number.isFinite(opacity) && opacity < min) min = opacity;
      el = el.parentElement;
    }
    return min;
  })).toBeGreaterThanOrEqual(0.99);
  await expect(page.locator("#phone-more")).toHaveCount(0);
}

async function atDesk(page: Page, staffId = "a.singh"): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
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

async function showTransfers(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator("#phone-more").getByRole("button", { name: "Transfers" }).click();
  await expect(page.locator('[data-phone="transfers"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transfers" })).toBeVisible();
}

async function openPhoneTransfers(page: Page, width: number, staffId = "a.singh"): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await atDesk(page, staffId);
  await showTransfers(page);
}

function summaryValue(detail: ReturnType<Page["getByRole"]>, label: string) {
  return detail.locator(".phone-summary div").filter({ hasText: label }).locator("dd");
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

function money(text: string): number {
  const match = text.replace(/,/g, "").match(/(\d+\.\d{2})/);
  expect(match, text).not.toBeNull();
  return Number(match![1]);
}

function rateNumber(text: string): number {
  const match = text.replace(/,/g, "").match(/(\d+\.\d+)/);
  expect(match, text).not.toBeNull();
  return Number(match![1]);
}

/* Amount × the rate printed on the sheet, in cents. A rate rounded
   so the product misses the gross fails this. */
function productCents(amountText: string, rateText: string): number {
  return Math.round(money(amountText) * rateNumber(rateText) * 100);
}

function obligations(page: Page) {
  return page.evaluate(() =>
    fetch("/api/ledger/obligations?limit=50").then((r) => r.json()),
  ) as Promise<{ obligations: Array<Record<string, string | null>> }>;
}

async function openTill(page: Page) {
  const book = ledger(page);
  const balances = await book.ensureOpeningBalances(OPENING);
  expect([201, 409]).toContain(balances.status);
  const opened = await page.evaluate(async () => {
    const r = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  expect([200, 201, 409]).toContain(opened.status);
  expect((await book.session())?.status).toBe("open");
  return book;
}

test("desktop transfers is unchanged at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await page.getByText(/^Transfers$/).first().click();
  await expect(page.getByText("Transfer pipeline", { exact: true })).toBeVisible();
  await expect(page.locator('[data-phone="transfers"]')).toHaveCount(0);
  await expect(page.getByText("Example data")).toHaveCount(0);
  await page.getByRole("button", { name: /TR-260618-003/ }).click();
  await expect(page.getByText("Tracking PIN")).toBeVisible();
  await expect(page.getByText("Partner acknowledged — ready in ~1h")).toBeVisible();
  await expect(page.getByText("Funded to Cebuana settlement")).toBeVisible();
  await settled(page);
});

test("transfers passes the phone sweep", async ({ page }) => {
  await openPhoneTransfers(page, 360);
  await phoneSweep(page, {
    roots: ['[data-phone="transfers"]', ".phone-head", "#phone-dock"],
  });
  await page.getByRole("button", { name: "New transfer" }).click();
  await page.getByLabel("Customer").fill("Rachel Carter");
  await page.getByRole("button", { name: /Maria Carter/ }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: /Tap to change the fee/ })).toBeVisible();
  await phoneSweep(page, { roots: [".ph-sheet"] });
});

for (const width of [360, 390]) {
  test(`the list, the chips, and a status update by hand at ${width}`, async ({ page }) => {
    await openPhoneTransfers(page, width);
    await expect(page.getByText("Payout partners are not connected. You change the status by hand when the partner confirms.")).toBeVisible();
    await expect(page.getByText("Example data")).toHaveCount(0);
    await expect(page.locator("#phone-fab")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "All 4" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "In progress 2" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "On hold 1" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Paid out 1" })).toBeVisible();
    await expect(page.getByText("In transit").first()).toBeVisible();
    const searchBox = await page.locator(".ph-xfer .phone-search").boundingBox();
    const chipBox = await page.locator(".ph-xfer .phone-chip").first().locator("span").boundingBox();
    expect(searchBox && chipBox).toBeTruthy();
    expect(Math.abs((chipBox?.x || 0) - (searchBox?.x || 0))).toBeLessThanOrEqual(2);
    const row = page.locator(".ph-xfer-row").first();
    const rowBox = await row.boundingBox();
    expect(rowBox && rowBox.height).toBeGreaterThanOrEqual(64);
    expect(rowBox && rowBox.height).toBeLessThanOrEqual(88);
    const name = row.locator(".phone-row-title");
    await expect(name).toHaveText("Rachel Carter");
    const nameClipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(nameClipped).toBe(false);
    await expect(row.locator(".phone-row-sub")).toHaveText("Philippines · Cash pickup");
    await expect(page.locator('[data-phone="transfers"]').getByRole("button", { name: "Mark paid out" })).toHaveCount(0);
    await waitOpaque(page);
    await shot(page, `transfers_list_${width}`);

    await page.getByRole("tab", { name: "On hold 1" }).click();
    await expect(page.getByText("Brooke Lawson")).toBeVisible();
    await expect(page.getByText("Jakob Miller")).toHaveCount(0);
    await waitOpaque(page);
    await shot(page, `transfers_filtered_${width}`);

    await page.getByRole("tab", { name: "All 4" }).click();
    await page.getByLabel("Find a name or TR number").fill("TR-260618-003");
    await expect(page.locator(".ph-xfer-row").first().locator(".phone-row-title")).toHaveText("Rachel Carter");
    await page.getByLabel("Find a name or TR number").fill("");
    await page.locator(".ph-xfer-row").filter({ hasText: "In transit" }).click();
    const detail = page.getByRole("dialog");
    await expect(detail.getByRole("heading", { name: "Maria Carter" })).toBeVisible();
    await expect(detail.getByText("TR-260618-003")).toBeVisible();
    await expect(detail.getByText("Rachel Carter to Maria Carter")).toBeVisible();
    await expect(detail.getByText("History")).toBeVisible();
    await expect(detail.getByText("Updated by staff, not by the partner.")).toBeVisible();
    await expect(detail.getByText("Jun 18, 2026, 10:12 AM")).toBeVisible();
    await expect(detail.getByText("Partner acknowledged")).toHaveCount(0);
    await expect(detail.getByText("marked by hand")).toHaveCount(0);
    await expect(detail.getByText("In transit · System · Jun 18, 2026, 10:31 AM")).toBeVisible();
    const stored = await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]") as Array<{ ref: string; recvAmt: number }>;
      return list.find((row) => row.ref === "TR-260618-003");
    });
    expect(stored && stored.recvAmt).toBeTruthy();
    await expect(summaryValue(detail, "Amount sent")).toHaveText("600.00 CAD");
    await expect(summaryValue(detail, "Fee")).toHaveText("9.99 CAD");
    await expect(summaryValue(detail, "Total paid")).toHaveText("609.99 CAD");
    const sentAmount = await summaryValue(detail, "Amount sent").innerText();
    const sentRate = await summaryValue(detail, "Rate").innerText();
    expect(productCents(sentAmount, sentRate)).toBe(Math.round(stored!.recvAmt * 100));
    expect(await detail.locator(".phone-summary dt").allTextContents()).toEqual([
      "Amount sent", "Fee", "Total paid", "Rate", "Method", "Partner",
    ]);
    await expect(summaryValue(detail, "Amount sent")).not.toHaveClass(/is-pos/);
    await expect(detail.getByText("Customer paid")).toHaveCount(0);
    await expect(detail.getByText("Receiver gets")).toHaveCount(0);
    await expect(detail.getByText("Desk reference")).toBeVisible();
    await expect(detail.getByText("Our own reference. Not a partner pickup code.")).toBeVisible();
    await expect(detail.getByText("48 221 905")).toBeVisible();
    await expect(detail.getByText(/PIN/)).toHaveCount(0);
    await expect(detail.locator(".ph-pin")).toHaveCount(0);
    const refFace = detail.locator(".ph-ref span");
    await expect(refFace).toHaveCSS("font-size", "16px");
    await expect(refFace).toHaveCSS("color", "rgb(22, 21, 19)");
    const copy = detail.getByRole("button", { name: "Copy" });
    const copyBox = await copy.boundingBox();
    expect(copyBox && copyBox.width).toBeGreaterThanOrEqual(44);
    expect(copyBox && copyBox.height).toBeGreaterThanOrEqual(44);
    const historyFit = await detail.locator(".ph-time li").evaluateAll((els) => els.map((el) => ({
      text: el.textContent || "",
      wraps: el.getClientRects().length > 1 || el.scrollHeight > 36,
      spills: el.scrollWidth > el.clientWidth + 1,
    })));
    expect(historyFit.every((line) => !line.wraps && !line.spills)).toBe(true);
    await expect(summaryValue(detail, "Total paid")).toHaveCSS("color", "rgb(22, 21, 19)");
    const back = detail.getByRole("button", { name: "Back" });
    const backBox = await back.boundingBox();
    expect(backBox && backBox.width).toBeGreaterThanOrEqual(44);
    expect(backBox && backBox.height).toBeGreaterThanOrEqual(44);
    const chevron = await back.locator("svg").boundingBox();
    expect(chevron && Math.round(chevron.width)).toBe(24);
    expect(chevron && Math.round(chevron.height)).toBe(24);
    await expect(back).toHaveCSS("color", "rgb(22, 21, 19)");
    const paint = await detail.evaluate((root) => {
      const button = (name: string) => [...root.querySelectorAll("button")].find((el) => (el.textContent || "").trim() === name);
      const read = (el: Element | undefined) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        return { bg: style.backgroundColor, color: style.color, border: style.borderTopColor };
      };
      return {
        paid: read(button("Mark paid out")),
        hold: read(button("Hold")),
      };
    });
    expect(paint.paid).toMatchObject({ bg: "rgb(31, 114, 105)", color: "rgb(255, 255, 255)" });
    expect(paint.hold).toEqual({ bg: "rgb(255, 255, 255)", color: "rgb(22, 21, 19)", border: "rgb(201, 197, 188)" });
    await expect(detail.getByRole("button", { name: "Cancel transfer" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Cancel is being fixed" })).toHaveCount(0);
    await expect(detail.getByText("Only the owner can cancel a transfer that took cash. Ask the owner to cancel.")).toBeVisible();
    await expect(detail.getByText("The cash stays recorded")).toHaveCount(0);
    await expect(detail.getByRole("alertdialog")).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Mark paid out" })).toBeVisible();
    await shot(page, `transfers_teller_cancel_${width}`);
    await detail.getByRole("button", { name: "Mark paid out" }).click();
    await expect(detail.getByRole("button", { name: "Mark paid out" })).toHaveCount(0);
    await detail.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("tab", { name: "Paid out 2" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "In progress 1" })).toBeVisible();
    await expect(page.locator('[data-phone="transfers"]').getByRole("button", { name: "Mark paid out" })).toHaveCount(0);
  });

  test(`an empty list at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page);
    await page.evaluate(() => localStorage.setItem("cdos_transfers_v1", "[]"));
    await page.locator('#phonebar [data-phone-app="more"]').click();
    await page.locator("#phone-more").getByRole("button", { name: "Transfers" }).click();
    await expect(page.getByText("No transfers yet.")).toBeVisible();
    await expect(page.getByText("Tap New transfer to send money for a customer.")).toBeVisible();
    await expect(page.getByRole("tab", { name: "All 0" })).toBeVisible();
    await waitOpaque(page);
    await shot(page, `transfers_empty_${width}`);
  });

  test(`a new transfer posts once at ${width}, and step 2 matches the book`, async ({ page }) => {
    test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page);
    const book = await openTill(page);
    const before = Number((await book.till()).CAD);
    const beforeBook = await obligations(page);
    const beforeCount = beforeBook.obligations.length;

    await page.locator('#phonebar [data-phone-app="more"]').click();
    await page.locator("#phone-more").getByRole("button", { name: "Transfers" }).click();
    await page.getByRole("button", { name: "New transfer" }).click();
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
    await page.getByLabel("Customer").fill("Rachel Carter");
    await page.getByRole("button", { name: /Maria Carter/ }).click();
    await shot(page, `transfers_step1_${width}`);
    await page.getByRole("button", { name: "Next", exact: true }).click();

    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await expect(page.getByText("How Maria gets it")).toBeVisible();
    const sheetFont = await page.locator(".ph-sheet").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(sheetFont).toContain("Inter");
    await page.getByLabel("Customer pays").focus();
    const focusBorder = await page.locator(".ph-sheet .phq-amt").evaluate((el) => getComputedStyle(el).borderColor);
    expect(focusBorder.replace(/\s/g, "")).toBe("rgb(31,114,105)");
    await page.getByLabel("Customer pays").fill("600");
    const getsRow = page.locator('[data-phone-cheque="transfer-gets"]');
    const handsRow = page.locator('[data-phone-cheque="transfer-hands"]');
    await expect(getsRow).toHaveText(/\d/);
    const feeLine = page.getByRole("button", { name: /Tap to change the fee/ });
    await expect(feeLine).toBeVisible();
    const feeBox = await feeLine.boundingBox();
    expect(feeBox && feeBox.height).toBeGreaterThanOrEqual(44);
    expect(feeBox && feeBox.width).toBeGreaterThanOrEqual(44);
    await page.getByLabel("Why is it being sent?").selectOption("Family support");
    const gets = money(await getsRow.innerText());
    const hands = money(await handsRow.innerText());
    expect(hands).toBeCloseTo(609.99, 2);
    expect(gets).toBeGreaterThan(0);
    await shot(page, `transfers_step2_${width}`);
    await page.getByRole("button", { name: "Next: check and create" }).click();

    await expect(page.getByText("Step 3 of 3")).toBeVisible();
    await expect(page.getByText("It does not send the money to the partner.")).toBeVisible();
    const stepGets = page.locator(".ph-sheet").locator('[data-phone-cheque="transfer-gets"]');
    await expect(stepGets).not.toHaveClass(/is-pos/);
    await expect(stepGets).toHaveCSS("color", "rgb(22, 21, 19)");
    await expect(stepGets).toHaveCSS("font-size", "20px");
    const stepBack = page.getByRole("button", { name: "Back" });
    const stepBackBox = await stepBack.boundingBox();
    expect(stepBackBox && stepBackBox.width).toBeGreaterThanOrEqual(44);
    expect(stepBackBox && stepBackBox.height).toBeGreaterThanOrEqual(44);
    await shot(page, `transfers_step3_${width}`);
    await page.getByTestId("transfer-create").evaluate((btn: HTMLButtonElement) => {
      btn.click();
      btn.click();
    });
    await expect(page.getByText(/Transfer created\./)).toBeVisible({ timeout: 30_000 });

    await expect.poll(async () => Number((await book.till()).CAD) - before, { timeout: 15_000 }).toBeCloseTo(hands, 2);
    const owed = await obligations(page);
    expect(owed.obligations.length).toBe(beforeCount + 1);
    const payable = owed.obligations.find((o) => o.kind === "remittance_payable" && Math.abs(Number(o.faceAmount) - gets) < 0.02);
    expect(payable, "the payout on the screen should be the payout on the book").toBeTruthy();
    expect(payable).toMatchObject({
      direction: "payable",
      status: "open",
      counterparty: "Cebuana Lhuillier",
      corridor: "PH",
      faceCurrency: "PHP",
      carryingAmountHome: "600.00",
      homeCurrency: "CAD",
    });
  });
}

for (const width of [360, 390]) {
  test(`a receive detail keeps the currencies apart at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page);
    await page.evaluate(() => {
      const pack = (window as unknown as { CDOS: { _transfers: { TKEY: string; defaultTransfers: () => unknown[] } } }).CDOS._transfers;
      const list = pack.defaultTransfers();
      list.push({
        id: "t-recv",
        ref: "TR-260618-901",
        pin: "11 222 333",
        direction: "receive",
        senderName: "Ana Cruz",
        beneficiaryId: "b1",
        corridor: "PH",
        ccy: "PHP",
        method: "cash",
        partner: "Cebuana Lhuillier",
        payAmt: 10000,
        recvAmt: 239.36,
        fee: 9.99,
        rate: 0.0239,
        date: "2026-06-18",
        status: "created",
        timeline: [{ status: "created", ts: "2026-06-18 10:12", by: "M. Costa" }],
      });
      localStorage.setItem(pack.TKEY, JSON.stringify(list));
    });
    await showTransfers(page);
    await page.getByText("Ana Cruz").click();
    const detail = page.getByRole("dialog");
    await expect(summaryValue(detail, "Amount received")).toHaveText("10,000.00 PHP");
    await expect(summaryValue(detail, "Rate")).toHaveText("0.024935 CAD/PHP");
    await expect(summaryValue(detail, "Gross")).toHaveText("249.35 CAD");
    await expect(summaryValue(detail, "Fee")).toHaveText("\u22129.99 CAD");
    await expect(summaryValue(detail, "Hand to customer")).toHaveText("239.36 CAD");
    const received = await summaryValue(detail, "Amount received").innerText();
    const receivedRate = await summaryValue(detail, "Rate").innerText();
    const grossText = await summaryValue(detail, "Gross").innerText();
    expect(productCents(received, receivedRate)).toBe(Math.round(money(grossText) * 100));
    expect(productCents(received, receivedRate)).toBe(24935);
    expect(await detail.locator(".phone-summary dt").allTextContents()).toEqual([
      "Amount received", "Rate", "Gross", "Fee", "Hand to customer", "Method", "Partner",
    ]);
    await expect(summaryValue(detail, "Hand to customer")).not.toHaveClass(/is-pos/);
    await expect(summaryValue(detail, "Hand to customer")).toHaveCSS("color", "rgb(22, 21, 19)");
    await expect(summaryValue(detail, "Hand to customer")).toHaveCSS("font-weight", "700");
    await expect(detail.getByText("The fee is kept from the proceeds. It does not leave the drawer.")).toBeVisible();
    await expect(detail.getByText("229.37")).toHaveCount(0);
    await expect(detail.getByText("Customer pays the 9.99 CAD fee")).toHaveCount(0);
    await expect(detail.getByText("Customer paid")).toHaveCount(0);
    await expect(detail.getByText("Receiver gets")).toHaveCount(0);
    await expect(detail.getByText("239.36 PHP")).toHaveCount(0);
    await expect(detail.getByText("10,000.00 CAD")).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Mark funded" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Mark as sent" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Mark paid out" })).toHaveCount(0);
    await shot(page, `transfers_receive_${width}`);
    await detail.getByRole("button", { name: "Mark funded" }).click();
    await expect(detail.locator(".ph-sum-who .phone-badge")).toHaveText("Funded");
    await expect(detail.getByRole("button", { name: "Mark ready for pickup" })).toBeVisible();
    await detail.getByRole("button", { name: "Mark ready for pickup" }).click();
    await expect(detail.locator(".ph-sum-who .phone-badge")).toHaveText("Ready for pickup");
    await expect(detail.getByRole("button", { name: "Mark paid to customer" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Mark as sent" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Mark paid out" })).toHaveCount(0);
  });
}

test("amount times the displayed rate equals the gross to the cent", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await atDesk(page);
  await page.evaluate(() => {
    const pack = (window as unknown as { CDOS: { _transfers: { TKEY: string; defaultTransfers: () => unknown[] } } }).CDOS._transfers;
    const list = pack.defaultTransfers() as Array<Record<string, unknown>>;
    list.push({
      id: "t-rate-send",
      ref: "TR-RATE-SEND",
      pin: "10 000 001",
      direction: "send",
      senderName: "Rate Send",
      beneficiaryId: "b1",
      corridor: "PH",
      ccy: "PHP",
      method: "cash",
      partner: "Cebuana Lhuillier",
      payAmt: 600,
      recvAmt: 23935.67,
      fee: 9.99,
      rate: +(23935.67 / 600).toFixed(4),
      date: "2026-06-18",
      status: "sent",
      timeline: [{ status: "created", ts: "2026-06-18 10:12", by: "M. Costa" }],
    });
    localStorage.setItem(pack.TKEY, JSON.stringify(list));
  });
  await showTransfers(page);
  await page.getByText("Rate Send").click();
  const detail = page.getByRole("dialog");
  const amount = await summaryValue(detail, "Amount sent").innerText();
  const rate = await summaryValue(detail, "Rate").innerText();
  expect(rate).not.toBe("39.8928 PHP/CAD");
  expect(productCents(amount, rate)).toBe(2393567);
  await expect(summaryValue(detail, "Total paid")).toHaveText("609.99 CAD");
  expect(await detail.locator(".phone-summary dt").allTextContents()).toEqual([
    "Amount sent", "Fee", "Total paid", "Rate", "Method", "Partner",
  ]);
});

test("history times convert midnight, noon, and the afternoon", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await atDesk(page);
    await page.evaluate(() => {
      const pack = (window as unknown as { CDOS: { _transfers: { TKEY: string; defaultTransfers: () => unknown[] } } }).CDOS._transfers;
      const list = pack.defaultTransfers();
      list.push({
      id: "t-time",
      ref: "TR-TIME-001",
      pin: "00 000 001",
      direction: "send",
      senderName: "Time Check",
      beneficiaryId: "b1",
      corridor: "PH",
      ccy: "PHP",
      method: "cash",
      partner: "Cebuana Lhuillier",
      payAmt: 10,
      recvAmt: 400,
      fee: 1,
      rate: 40,
      date: "2026-06-18",
      status: "sent",
      timeline: [
        { status: "created", ts: "2026-06-18 00:15", by: "M. Costa" },
        { status: "sent", ts: "2026-06-18 12:00", by: "M. Costa" },
      ],
    });
    localStorage.setItem(pack.TKEY, JSON.stringify(list));
  });
  await showTransfers(page);
  await page.getByText("Time Check").click();
  const detail = page.getByRole("dialog");
  const clock = await detail.locator(".ph-time").innerText();
  expect(clock).toContain("Created · M. Costa · Jun 18, 2026, 12:15 AM");
  expect(clock).toContain("Sent · M. Costa · Jun 18, 2026, 12:00 PM");
  expect(clock).not.toMatch(/00:15/);
  expect(clock).not.toMatch(/12:15 am/);
  expect(clock).not.toMatch(/12:00 am/i);
  expect(clock).not.toContain("12:00 AM");
  await detail.getByRole("button", { name: "Back" }).click();
  await page.getByRole("tab", { name: /On hold/ }).click();
  await page.getByText("Brooke Lawson").click();
  const afternoon = await page.getByRole("dialog").locator(".ph-time").innerText();
  expect(afternoon).toContain("On hold · J. Masri · Jun 17, 2026, 3:06 PM");
  expect(afternoon).not.toMatch(/15:06/);
  expect(afternoon).not.toMatch(/3:06 pm/);
});

test("hold then release returns to the previous status", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await atDesk(page);
  await showTransfers(page);
  await page.locator(".ph-xfer-row").filter({ hasText: "In transit" }).click();
  const transit = page.getByRole("dialog");
  await transit.getByRole("button", { name: "Hold" }).click();
  await expect(transit.locator(".ph-sum-who .phone-badge")).toHaveText("On hold");
  await transit.getByRole("button", { name: "Release" }).click();
  await expect(transit.locator(".ph-sum-who .phone-badge")).toHaveText("In transit");
  await expect(transit.getByRole("button", { name: "Mark paid out" })).toBeVisible();
  await expect(transit.getByRole("button", { name: "Mark in transit" })).toHaveCount(0);
  const transitLines = await transit.locator(".ph-time li").allTextContents();
  expect(transitLines[transitLines.length - 1]).toMatch(/^In transit · /);
  expect(transitLines.some((line) => line.startsWith("Sent · A. Singh"))).toBe(false);
  await transit.getByRole("button", { name: "Back" }).click();
  await page.getByRole("tab", { name: /On hold/ }).click();
  await page.getByText("Brooke Lawson").click();
  const held = page.getByRole("dialog");
  await held.getByRole("button", { name: "Release" }).click();
  await expect(held.locator(".ph-sum-who .phone-badge")).toHaveText("Created");
  await expect(held.getByRole("button", { name: "Mark as sent" })).toBeVisible();
  await expect(held.getByRole("button", { name: "Mark in transit" })).toHaveCount(0);
  await expect(held.locator(".ph-sum-who .phone-badge")).not.toHaveText("Sent");
});

for (const width of [360, 390]) {
  test(`the owner sees cancel disabled until the reversal is wired at ${width}`, async ({ page }) => {
    await openPhoneTransfers(page, width, "j.masri");
    await page.locator(".ph-xfer-row").filter({ hasText: "In transit" }).click();
    const detail = page.getByRole("dialog");
    const cancel = detail.getByRole("button", { name: "Cancel is being fixed" });
    await expect(cancel).toBeVisible();
    await expect(cancel).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Cancel transfer" })).toHaveCount(0);
    await expect(detail.getByText("Only the owner can cancel a transfer that took cash. Ask the owner to cancel.")).toHaveCount(0);
    await expect(detail.getByText("The cash stays recorded")).toHaveCount(0);
    await expect(detail.getByText("Amount sent")).toBeVisible();
    await expect(detail.getByText("Total paid")).toBeVisible();
    await shot(page, `transfers_detail_${width}`);
    await cancel.click({ force: true });
    await expect(detail.locator(".ph-sum-who .phone-badge")).toHaveText("In transit");
    await expect(detail.getByText("Cancelled")).toHaveCount(0);
  });
}

test("a receive pays the stored payout out of the drawer", async ({ page }) => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");
  await page.setViewportSize({ width: 360, height: 844 });
  await atDesk(page);
  const book = await openTill(page);
  const before = Number((await book.till()).CAD);
  await showTransfers(page);
  await page.getByRole("button", { name: "New transfer" }).click();
  await page.getByRole("option", { name: "Receive in" }).click();
  await page.getByLabel("Customer").fill("Rachel Carter");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Amount received").fill("10000");
  await page.getByLabel("Why is it being sent?").selectOption("Family support");
  const named = page.getByLabel("Beneficiary name");
  if (await named.isVisible()) {
    await named.fill("Rachel Carter");
    await page.getByLabel("Beneficiary address").fill("12 Harbour Street");
  }
  await page.getByRole("button", { name: "Next: check and create" }).click();
  await page.getByTestId("transfer-create").click();
  await expect(page.getByText(/Transfer created\./)).toBeVisible({ timeout: 30_000 });
  const detail = page.getByRole("dialog");
  const hand = money(await summaryValue(detail, "Hand to customer").innerText());
  const fee = money(await summaryValue(detail, "Fee").innerText());
  const gross = money(await summaryValue(detail, "Gross").innerText());
  const received = await summaryValue(detail, "Amount received").innerText();
  const receivedRate = await summaryValue(detail, "Rate").innerText();
  expect(Math.round(gross * 100)).toBe(Math.round(hand * 100) + Math.round(fee * 100));
  expect(productCents(received, receivedRate)).toBe(Math.round(gross * 100));
  await expect(detail.getByRole("button", { name: "Mark funded" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Mark as sent" })).toHaveCount(0);
  await expect.poll(async () => before - Number((await book.till()).CAD), { timeout: 15_000 }).toBeCloseTo(hand, 2);
  const owed = await obligations(page);
  const receivable = owed.obligations.find((o) => o.kind === "remittance_receivable" && Math.abs(Number(o.faceAmount) - 10000) < 0.02);
  expect(receivable, "the receive should be on the book").toBeTruthy();
  expect(Number(receivable!.carryingAmountHome)).toBeCloseTo(gross, 2);
  expect(Number(receivable!.carryingAmountHome)).toBeCloseTo(hand + fee, 2);
});
