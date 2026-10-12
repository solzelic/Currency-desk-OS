/* Cancelling a transfer that took cash, driven from the desktop.

   The screen used to mark the row cancelled and tell nobody to post the
   reversal. The drawer kept the cash and the partner stayed owed. This
   spec opens the confirm sheet, reads the sentence the cashier is shown,
   and then asks the ledger whether the drawer and the obligation went
   back. */
import { mkdirSync } from "node:fs";
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const OPENING = { CAD: "25000.00", USD: "12000.00" };
const SHOTS = "/opt/cursor/artifacts/screenshots";

function obligations(page: Page) {
  return page.evaluate(() =>
    fetch("/api/ledger/obligations?limit=50").then((r) => r.json()),
  ) as Promise<{
    obligations: Array<Record<string, string | null>>;
    outstanding: { payable: string | null; receivable: string | null };
  }>;
}

function grouped(amount: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  expect(match, `ledger figure ${amount}`).not.toBeNull();
  let frac = (match![3] || "00").slice(0, 2);
  while (frac.length < 2) frac += "0";
  const whole = match![2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${match![1]}${whole}.${frac}`;
}

/* Two decimals, no thousands separators. The sheet prints grouped
   digits; the ledger stores the plain amount. */
function plain(amount: string) {
  return grouped(amount).replace(/,/g, "");
}

async function openDeskAndTill(page: Page, staffId = "a.singh") {
  await signInAtDesk(page, staffId);
  const book = ledger(page);
  const balances = await book.ensureOpeningBalances(OPENING);
  expect([201, 409]).toContain(balances.status);
  const opened = await page.evaluate(async () => {
    const r = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return r.status;
  });
  expect([200, 201, 409]).toContain(opened);
  expect((await book.session())?.status).toBe("open");
  return book;
}

function transferForm(page: Page) {
  return page
    .locator("div.fixed.inset-0")
    .filter({ has: page.getByRole("button", { name: /Create transfer/i }) });
}

async function sendSixHundred(page: Page) {
  await page.getByText(/^Transfers$/).first().click();
  const open = page.getByRole("button", { name: /New transfer/i }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();
  const form = transferForm(page);
  await expect(form.getByPlaceholder(/Type a name…/)).toBeVisible();
  await form.getByPlaceholder(/Type a name…/).fill("Rachel Carter");
  const suggestion = form.getByRole("button", { name: "Rachel Carter", exact: true });
  if (await suggestion.count()) await suggestion.first().click();
  else await form.getByPlaceholder(/Type a name…/).press("Tab");
  await form.locator("button").filter({ hasText: "Maria Carter" }).click();
  await form.getByPlaceholder("0.00").first().fill("600");
  await form.getByRole("combobox").filter({ hasText: /Family support|Select a purpose/ })
    .selectOption("Family support");
  const body = await form.innerText();
  const collect = body.match(/Collect \$?([\d,]+(?:\.\d{2})?)/);
  expect(collect).not.toBeNull();
  expect(Number(collect![1]!.replace(/,/g, ""))).toBeCloseTo(609.99, 2);
  await form.getByRole("button", { name: /Create transfer/i }).click();
  await expect(form).toHaveCount(0, { timeout: 30_000 });
}

test("the confirm sheet quotes the server, and cancel puts the drawer back", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  const dealGets: string[] = [];
  const cancelKeys: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (req.method() === "GET" && /\/api\/ledger\/obligation-deals\/[^/]+$/.test(url)) dealGets.push(url);
  });
  await page.route("**/api/ledger/obligation-deals/*/reversal", async (route) => {
    const body = route.request().postDataJSON() as { idempotencyKey?: string };
    cancelKeys.push(String(body.idempotencyKey || ""));
    if (cancelKeys.length === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL_ERROR", message: "Try the cancel again." }),
      });
      return;
    }
    await route.continue();
  });
  const book = await openDeskAndTill(page);
  const before = Number((await book.till()).CAD);
  const payableBefore = (await obligations(page)).outstanding.payable;
  await sendSixHundred(page);

  await expect
    .poll(async () => Number((await book.till()).CAD) - before, { timeout: 15_000 })
    .toBeCloseTo(609.99, 2);

  const drawer = page.locator("div.fixed.inset-0.flex.justify-end");
  const ledgerLine = await drawer.getByText(/^Ledger /).innerText();
  const ref = ledgerLine.replace(/^Ledger\s+/, "").trim();
  const owed = await obligations(page);
  const row = owed.obligations.find((o) => o.transactionRef === ref && o.status === "open");
  expect(row, "the send should be an open obligation").toBeTruthy();
  expect(row).toMatchObject({
    cashInHome: "609.99",
    counterparty: "Cebuana Lhuillier",
    homeCurrency: "CAD",
    faceCurrency: "PHP",
  });
  /* D5: the local row is a different amount and a different fee.
     The sheet has to keep the server's 609.99 CAD and 24,326.46 PHP. */
  await page.locator("[data-transfer-cancel='open']").evaluate((button) => {
    const stored = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]");
    for (const row of stored) {
      if (row && row.serverTransactionId) {
        row.payAmt = 1.11;
        row.fee = 77.77;
      }
    }
    localStorage.setItem("cdos_transfers_v1", JSON.stringify(stored));
    const key = Object.keys(button).find((name) => name.startsWith("__reactFiber"));
    let fiber = key ? (button as unknown as Record<string, { return?: unknown; memoizedProps?: { t?: { payAmt?: number; fee?: number; serverTransactionId?: string } } }>)[key] : undefined;
    while (fiber) {
      const transfer = fiber.memoizedProps && fiber.memoizedProps.t;
      if (transfer && transfer.serverTransactionId) {
        transfer.payAmt = 1.11;
        transfer.fee = 77.77;
        return;
      }
      fiber = fiber.return as typeof fiber;
    }
    throw new Error("the open transfer was not on the screen");
  });
  await page.locator("[data-transfer-cancel='open']").click();
  const effect = page.locator("[data-transfer-cancel='effect']");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  const shown = (await effect.innerText()).replace(/\s+/g, " ").trim();
  const parsed = shown.match(
    /^This gives the customer back ([\d,]+\.\d{2}) ([A-Z]{3}) from your drawer and cancels the ([\d,]+\.\d{2}) ([A-Z]{3}) owed to (.+)\.$/,
  );
  expect(parsed, shown).not.toBeNull();
  /* The digits on the sheet are the stored till movement and the stored
     partner face. A browser price that is not what the ledger kept fails
     here, even when the sentence is otherwise well formed. */
  expect(parsed![1]!.replace(/,/g, "")).toBe(plain(row!.cashInHome!));
  expect(parsed![2]).toBe(row!.homeCurrency);
  expect(parsed![3]!.replace(/,/g, "")).toBe(plain(row!.faceAmount!));
  expect(parsed![4]).toBe(row!.faceCurrency);
  expect(parsed![5]).toBe(row!.counterparty);
  expect(shown).toBe(
    `This gives the customer back ${grouped(row!.cashInHome!)} ${row!.homeCurrency} from your drawer ` +
    `and cancels the ${grouped(row!.faceAmount!)} ${row!.faceCurrency} owed to ${row!.counterparty}.`,
  );
  /* D5: the sheet's only figures are the stored cash and face. The
     lookup that filled it was that transaction, not the newest page. */
  expect(dealGets.some((url) => url.endsWith(`/api/ledger/obligation-deals/${row!.transactionId}`))).toBe(true);
  const byId = await page.evaluate(async (transactionId) => {
    const response = await fetch(`/api/ledger/obligation-deals/${transactionId}`);
    return response.json();
  }, row!.transactionId);
  expect(parsed![1]!.replace(/,/g, "")).toBe(plain(byId.cashInHome));
  expect(parsed![3]!.replace(/,/g, "")).toBe(plain(byId.faceAmount));
  expect(shown).toContain("609.99 CAD");
  expect(shown).toContain("24,326.46 PHP");
  expect(shown).not.toContain("1.11");
  expect(shown).not.toContain("77.77");
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-confirm-1280.png` });
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(effect).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-confirm-360.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(effect).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-confirm-390.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  const cancel = page.getByRole("button", { name: "Cancel transfer" });
  await expect(cancel).toBeDisabled();
  await page.getByRole("checkbox", { name: "I checked with the partner: it has not been paid out" }).check();
  await page.getByRole("textbox", { name: "Reason" }).fill("Wrong beneficiary");
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.locator("[data-transfer-cancel='confirm'] [role='alert']")).toContainText("Try the cancel again.");
  await expect(cancel).toBeVisible();
  await cancel.click();
  expect(cancelKeys).toEqual([
    `web:transfer-cancel:${row!.transactionId}`,
    `web:transfer-cancel:${row!.transactionId}`,
  ]);
  await expect(page.locator("[data-transfer-cancel='confirm']")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("[data-transfer-cancel='timeline']")).toHaveText(
    /^Cancelled by A\. Singh at \d{1,2}:\d{2} [AP]M, Wrong beneficiary$/,
  );
  await expect
    .poll(async () => Number((await book.till()).CAD) - before, { timeout: 15_000 })
    .toBeCloseTo(0, 2);
  await expect.poll(async () => {
    const bookNow = await obligations(page);
    return {
      status: bookNow.obligations.find((o) => o.transactionId === row!.transactionId)?.status,
      payable: bookNow.outstanding.payable,
    };
  }).toEqual({ status: "reversed", payable: payableBefore });
});

test("a cashier is told to ask a manager, and Cancel is not offered", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  /* A cashier cannot set opening balances. The test above already opened
     this till, and the two run in order. */
  await signInAtDesk(page, "m.costa");
  const book = ledger(page);
  expect((await book.session())?.status).toBe("open");
  const before = Number((await book.till()).CAD);
  await sendSixHundred(page);
  await expect
    .poll(async () => Number((await book.till()).CAD) - before, { timeout: 15_000 })
    .toBeCloseTo(609.99, 2);

  const teller = page.locator("[data-transfer-cancel='teller']");
  await expect(teller).toHaveText(
    "Only a manager can cancel a transfer that took cash. Ask a manager to cancel.",
  );
  await expect(page.locator("[data-transfer-cancel='open']")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-teller-1280.png` });
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 844 });
    await teller.scrollIntoViewIfNeeded();
    await expect(teller).toBeVisible();
    const fits = await teller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits, `cashier notice overflows at ${width}`).toBe(true);
    await page.screenshot({ path: `${SHOTS}/transfer-cancel-teller-${width}.png` });
  }

  const ledgerLine = await page.locator("div.fixed.inset-0.flex.justify-end").getByText(/^Ledger /).innerText();
  const ref = ledgerLine.replace(/^Ledger\s+/, "").trim();
  const owed = await obligations(page);
  const row = owed.obligations.find((o) => o.transactionRef === ref && o.status === "open");
  expect(row).toBeTruthy();
  await page.evaluate(async (transactionId) => {
    const login = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "a.singh", password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    if (!login.ok) throw new Error(`cleanup login ${login.status}`);
    const reversed = await fetch(`/api/ledger/obligation-deals/${transactionId}/reversal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `web:transfer-cancel:${transactionId}`,
        reason: "Seam cleanup",
        partnerConfirmedNotPaid: true,
      }),
    });
    if (!reversed.ok) throw new Error(`cleanup reversal ${reversed.status}`);
  }, row!.transactionId);
});
