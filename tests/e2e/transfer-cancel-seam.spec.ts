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
  ) as Promise<{ obligations: Array<Record<string, string | null>> }>;
}

function grouped(amount: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  expect(match, `ledger figure ${amount}`).not.toBeNull();
  let frac = (match![3] || "00").slice(0, 2);
  while (frac.length < 2) frac += "0";
  const whole = match![2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${match![1]}${whole}.${frac}`;
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
  const book = await openDeskAndTill(page);
  const before = Number((await book.till()).CAD);
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
  const sentence =
    `This gives the customer back ${grouped(row!.cashInHome!)} ${row!.homeCurrency} from your drawer ` +
    `and cancels the ${grouped(row!.faceAmount!)} ${row!.faceCurrency} owed to ${row!.counterparty}.`;

  await page.locator("[data-transfer-cancel='open']").click();
  const effect = page.locator("[data-transfer-cancel='effect']");
  await expect(effect).toHaveText(sentence, { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-confirm-1280.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(effect).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-confirm-390.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole("button", { name: "Cancel transfer" }).click();
  await expect(page.locator("[data-transfer-cancel='confirm']")).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => Number((await book.till()).CAD) - before, { timeout: 15_000 })
    .toBeCloseTo(0, 2);
  await expect.poll(async () => {
    const bookNow = await obligations(page);
    return bookNow.obligations.find((o) => o.transactionId === row!.transactionId)?.status;
  }).toBe("reversed");
});

test("a teller is told to ask the owner, and Cancel is not offered", async ({ page }) => {
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
    "Only the owner can cancel a transfer that took cash. Ask the owner to cancel.",
  );
  await expect(page.locator("[data-transfer-cancel='open']")).toHaveCount(0);
  await teller.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-teller-1280.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(teller).toBeVisible();
  await teller.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/transfer-cancel-teller-390.png` });

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
      }),
    });
    if (!reversed.ok) throw new Error(`cleanup reversal ${reversed.status}`);
  }, row!.transactionId);
});
