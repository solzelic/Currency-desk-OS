/* ============================================================
   Cashing a cheque in a real browser, and asking the book about it.

   The Cheques desk's own header claimed that cashing "posts a ledger row
   … so cash, fees and the audit trail stay on the one source of truth."
   It did not. `save()` built a transaction in JavaScript, pushed it into
   an array, wrote the cheque into `localStorage`, and the drawer on the
   screen fell while the drawer on the server did not move at all.

   That defect could not have been caught by either suite on its own. The
   server tests exercised a ledger the screen never called; the browser
   tests exercised a screen that was internally consistent about money it
   had invented. So this file drives the actual capture modal in a real
   browser and then asks the ledger — from inside the same signed-in page,
   through the same session and the same workspace header — whether the
   drawer moved, whether the journal is there, and whether the cheque the
   desk is carrying is one the server has heard of.

   Every fixture here asserts. A helper that fires a request and ignores
   the response hid a 500 in this repository for months, and a test whose
   setup fails silently fails later on something unrelated.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, ledger } from "./fixtures";
import type { Page } from "@playwright/test";

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as { Pool: new (c: { connectionString: string }) => { query: (sql: string, params?: unknown[]) => Promise<{ rows: { session_id: string; day: string }[] }>; end: () => Promise<void> } };

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/* The reads this file holds the screen to, asked of the server from
   inside the page — the same cookie, the same x-workspace-id, the same
   answer the screen itself is getting. */
function book(page: Page) {
  const get = (url: string) => page.evaluate((u) => fetch(u).then((r) => r.json()), url);
  return {
    till: () => get("/api/ledger/till-balances").then((r: any) => r.balances ?? {}),
    cheques: () => get("/api/ledger/cheques").then((r: any) => r.cheques ?? []),
    summary: () => get("/api/ledger/summary"),
    transactions: () => get("/api/ledger/transactions?limit=200").then((r: any) => r.transactions ?? []),
  };
}

/* A till has to be open before anything can be posted against it, and the
   seam database outlives a run — cash-seam closes the session it opened,
   so this file cannot assume one. Opened through the product's own route:
   setup that lies about how the product works stops catching the product
   breaking. */
async function ensureOpenSession(page: Page) {
  const status = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return opened.ok ? "open" : `${opened.status} ${await opened.text()}`;
  });
  await page.reload();
  /* ANY reload puts an owner back on the station chooser. A helper that
     reloads and does not land the caller again leaves the next click
     hunting for a screen that is not there. */
  await landOnDesktop(page);
  return status;
}

/** Enough home currency in the drawer to front a cheque against. */
async function ensureDrawerHas(page: Page, wanted: number) {
  return page.evaluate(async (want) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const have = Number(held.balances?.CAD ?? 0);
    if (have >= want) return "ok";
    const answer = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `chq-seam-topup-${Date.now()}`,
        direction: "in",
        currency: "CAD",
        amount: (want - have).toFixed(2),
        counterpartyType: "bank",
        counterpartyRef: "seam-fixture",
        reason: "Top-up so the cheque seam has a drawer that can front cash",
      }),
    });
    return answer.ok ? "ok" : `${answer.status} ${await answer.text()}`;
  }, wanted);
}

async function openCheques(page: Page) {
  await page.getByText(/^Cheques$/).first().click();
  await expect(page.getByText(/Cheque clearing/i).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Fill in the capture modal the way a teller does and press the button.
 *
 * Deliberately typed into the real inputs rather than posted through the
 * API: what is being tested is the seam, and a test that calls the
 * endpoint itself would go green over a screen that never learned to.
 */
async function cashACheque(
  page: Page,
  cheque: { amount: string; number: string; maker: string; bank: string; customer: string },
) {
  await page.getByRole("button", { name: /Cash a cheque/i }).first().click();
  await expect(page.getByText(/Cash a cheque/i).first()).toBeVisible();

  await page.getByPlaceholder("Type a name…").fill(cheque.customer);
  // Payroll: 2% with a $5 minimum, one day of hold — from the fee schedule
  await page.getByRole("button", { name: /^Payroll$/ }).click();
  await page.getByPlaceholder("0.00").fill(cheque.amount);
  await page.getByPlaceholder("e.g. 004821").fill(cheque.number);
  await page.getByPlaceholder("Payer name / business").fill(cheque.maker);
  await page.getByPlaceholder("e.g. RBC Royal Bank").fill(cheque.bank);
  await page.locator("button", { hasText: "Signed on the back" }).click();

  await page.getByRole("button", { name: /Cash & hold/i }).click();
}

/* ------------------------------------------------------------------
   1. THE CASH ACTUALLY LEAVES THE BOOK'S DRAWER
   ------------------------------------------------------------------ */
test("cashing a cheque at the counter moves the ledger's drawer, not just the screen's", async ({ page }) => {
  await signInAtDesk(page);

  const session = await ensureOpenSession(page);
  expect(session, `the till would not open: ${session}`).toBe("open");
  const topUp = await ensureDrawerHas(page, 6000);
  expect(topUp, `the drawer could not be topped up: ${topUp}`).toBe("ok");

  const server = book(page);
  const before = Number((await server.till()).CAD);
  const chequesBefore = (await server.cheques()).length;

  await openCheques(page);
  await cashACheque(page, {
    amount: "1200",
    number: "88204",
    maker: "Maple Payroll Services",
    bank: "Scotiabank",
    customer: "Seam Cheque Customer",
  });

  /* THE ASSERTION THIS FILE EXISTS FOR. Face 1,200, payroll fee 2% = 24,
     net 1,176 — and the LEDGER's drawer is 1,176 lighter. Polled, because
     the modal posts and the answer lands a moment later; a straight read
     here would pass on the balance from before the call. */
  await expect
    .poll(async () => Number((await server.till()).CAD), { timeout: 25_000 })
    .toBe(before - 1176);

  const cheques = await server.cheques();
  expect(cheques).toHaveLength(chequesBefore + 1);
  const cashed = cheques.find((c: any) => c.chequeNumber === "88204");
  expect(cashed, "the cheque is not on the ledger's register").toBeTruthy();
  expect(cashed.faceAmount).toBe("1200.00");
  expect(cashed.feeAmount).toBe("24.00");
  expect(cashed.netAmount).toBe("1176.00");
  expect(cashed.status).toBe("held");
  expect(cashed.maker).toBe("Maple Payroll Services");
  /* The reference and the hold date are the SERVER's. The browser used to
     mint both — the reference from the length of its own list, which is
     how two tills produced the same one for different money. */
  expect(cashed.ref).toMatch(/^CHQ-\d{6}-\d{3}$/);
  expect(cashed.holdUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  /* And the deal is in the book as a CHEQUE CASHING, carrying what
     actually crossed the counter — a cheque in, cash out. Every amount
     column on that row says Canadian dollars both ways. */
  const posted = (await server.transactions()).find(
    (t: any) => t.transactionId === cashed.cashingTransactionId,
  );
  expect(posted, "the cashing is not in the ledger's transactions").toBeTruthy();
  expect(posted.dealKind).toBe("cheque_cashing");
  expect(posted.receivedInstrument).toBe("cheque");
  expect(posted.disbursedInstrument).toBe("cash");
  expect(posted.inputAmount).toBe("1200.00");
  expect(posted.outputAmount).toBe("1176.00");
  // no cost basis: the cash paid out is the home currency, whose cost is 1
  expect(posted.realizedPnlHome).toBeNull();
  expect(posted.costOfSaleHome).toBeNull();

  // and the screen is showing the ledger's cheque, not one of its own
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: 20_000 })
    .toContain(cashed.ref);
  expect(await page.locator("body").innerText()).toContain("Maple Payroll Services");
});

/* ------------------------------------------------------------------
   2. THE DESK IS SHOWING THE BOOK'S EXPOSURE, NOT A SEED
   ------------------------------------------------------------------ */
test("the cheques on screen are the cheques the ledger is carrying", async ({ page }) => {
  await signInAtDesk(page);
  const server = book(page);
  const held = (await server.cheques()).filter((c: any) => c.status === "held");

  await openCheques(page);
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: 20_000 })
    .toMatch(held.length ? new RegExp(held[0].ref) : /Nothing here|Cash at risk/);
  const screen = await page.locator("body").innerText();

  /* "Cash at risk" is the desk's own credit exposure and it used to be
     totalled over four demonstration cheques compiled into the browser —
     $9,300 of exposure on a desk that had never cashed anything. Those
     four are gone wherever there is a ledger, and their fingerprints are
     what proves it. */
  for (const fingerprint of ["Northbridge Imports", "Service Canada", "Brooke Lawson", "CHQ-260616-004"]) {
    expect(screen, `the demo cheque register is back: ${fingerprint}`).not.toContain(fingerprint);
  }

  // every cheque the book says is outstanding is named on the screen
  for (const cheque of held) expect(screen).toContain(cheque.ref);

  /* And the exposure figure is the sum of the NET of those cheques —
     the cash that actually left the drawer, not the face of the paper. */
  const exposure = held.reduce((total: number, c: any) => total + Number(c.netAmount), 0);
  if (exposure > 0) {
    expect(screen).toContain(
      exposure.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
  }
});

/* ------------------------------------------------------------------
   3. CLEARING IT DOES NOT PUT THE MONEY BACK IN THE DRAWER
   ------------------------------------------------------------------ */
test("marking a cheque cleared writes a journal and leaves the drawer alone", async ({ page }) => {
  await signInAtDesk(page);
  const server = book(page);
  const outstanding = (await server.cheques()).filter((c: any) => c.status === "held");
  expect(
    outstanding.length,
    "no cheque is outstanding — the first test in this file should have left one",
  ).toBeGreaterThan(0);
  const target = outstanding[0];
  const before = Number((await server.till()).CAD);

  await openCheques(page);
  await page.getByText(target.ref).first().click();
  await expect(page.getByRole("button", { name: /Mark cleared/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Mark cleared/i }).click();

  await expect
    .poll(
      async () =>
        (await server.cheques()).find((c: any) => c.chequeId === target.chequeId)?.status,
      { timeout: 25_000 },
    )
    .toBe("cleared");

  /* THE DRAWER DOES NOT MOVE. The funds arrive at the bank; the cash the
     desk fronted left on the day of the cashing and is not coming back
     over the counter. A clearance that credited the till would put the
     same money in the drawer twice. */
  expect(Number((await server.till()).CAD)).toBe(before);

  /* And the clearance is not counted as a deal. One cheque cashed and
     then cleared must read as ONE deal at its own face value — this is
     the number a reporting threshold is tested against. */
  const cleared = (await server.cheques()).find((c: any) => c.chequeId === target.chequeId);
  const listed = await server.transactions();
  expect(
    listed.some((t: any) => t.transactionId === cleared.settlementTransactionId),
    "a settlement should not appear in the deal list",
  ).toBe(false);
});

/* The grey Cash & hold button is not a dead control. It tells the
   teller what is missing, and a tap moves the sheet to that box.
   Dates and amounts on the same sheet are for a person, not a parser. */
test("the capture sheet names the missing signature and writes a date and an amount a person can read", async ({ page }) => {
  await signInAtDesk(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await openCheques(page);
  await page.getByRole("button", { name: /Cash a cheque/i }).first().click();
  await page.getByPlaceholder("Type a name…").fill("Seam Cheque Customer");
  await page.getByRole("button", { name: /^Payroll$/ }).click();
  await page.getByPlaceholder("0.00").fill("1200");
  await page.getByPlaceholder("e.g. 004821").fill("88204");
  await page.getByPlaceholder("Payer name / business").fill("Maple Payroll Services");
  await page.getByPlaceholder("e.g. RBC Royal Bank").fill("Scotiabank");

  const why = page.getByText("Tick Signed on the back to cash this cheque.");
  await expect(why).toBeVisible();
  const whyBox = await why.boundingBox();
  const net = page.getByText("Cash to customer now").locator("xpath=following-sibling::div[1]");
  const hold = page.getByText("At risk until").locator("xpath=following-sibling::div[1]");
  await expect(net).toHaveText("1,176.00");
  await expect(hold).toHaveText(/^Oct \d{1,2}, \d{4}$/);
  await expect(net).toHaveCSS("font-size", "28px");
  await expect(hold).toHaveCSS("font-size", "20px");
  expect(await page.evaluate(() => (window as unknown as { CDOS: { _cheques: { sheetMoney: (n: number) => string; sheetDate: (d: string) => string } } }).CDOS._cheques.sheetMoney(1200))).toBe("1,200.00");
  expect(await page.evaluate(() => (window as unknown as { CDOS: { _cheques: { sheetDate: (d: string) => string } } }).CDOS._cheques.sheetDate("2026-10-17"))).toBe("Oct 17, 2026");

  const cash = page.getByRole("button", { name: "Cash & hold" });
  const cashBox = await cash.boundingBox();
  expect(whyBox!.y + whyBox!.height).toBeLessThanOrEqual(cashBox!.y + 1);
  expect(whyBox!.height).toBeLessThan(24);
  /* The row sits inside the Endorsement label, so its accessible name
     is that label. The words on the row are what the teller taps. */
  const signed = page.locator("button", { hasText: "Signed on the back" });
  await expect(cash).toBeDisabled();
  expect(Math.round((await cash.boundingBox())!.height)).toBe(44);
  expect(Math.round((await signed.boundingBox())!.height)).toBe(44);

  await cash.click({ force: true });
  const marked = page.locator('[data-endorsement-box="marked"]');
  await expect(marked).toBeVisible();
  expect(await marked.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");

  await signed.click();
  await expect(cash).toBeEnabled();
});

/* 360 is one column. The amount is 1,200.00, CAD sits beside it,
   and the cheque number is underneath so no digit is clipped. */
test("a 360 viewport shows the full formatted cheque amount", async ({ page }) => {
  await signInAtDesk(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await openCheques(page);
  await page.getByRole("button", { name: /Cash a cheque/i }).first().click();
  await page.getByRole("button", { name: /^Payroll$/ }).click();
  const amount = page.getByPlaceholder("0.00");
  await amount.fill("1200");
  await amount.blur();
  await expect(amount).toHaveValue("1,200.00");
  await page.setViewportSize({ width: 360, height: 844 });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(amount).toHaveValue("1,200.00");
  await expect(page.getByText("Cash to customer now").locator("xpath=following-sibling::div[1]")).toHaveText("1,176.00");
  await expect.poll(async () => amount.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const cad = await amount.locator("xpath=preceding-sibling::span[1]").boundingBox();
  const box = await amount.boundingBox();
  expect(cad!.y).toBeLessThan(box!.y + box!.height);
  expect(box!.y).toBeLessThan(cad!.y + cad!.height);
  const numberBox = await page.getByPlaceholder("e.g. 004821").boundingBox();
  expect(numberBox!.y).toBeGreaterThan(box!.y + box!.height - 2);
});

/* 00:30 in Toronto is still the previous trading day when the till
   was opened yesterday. The hold adds to that day, not to the
   browser's wall clock. */
test.describe("the capture hold follows the till", () => {
  test.use({ timezoneId: "America/Toronto" });
  let pool: InstanceType<typeof Pool>;

  test.beforeAll(async () => {
    if (!hasLedger) return;
    pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  });
  test.afterAll(async () => {
    await pool?.end();
  });

  test("a payroll hold at 12:30 AM Toronto uses the till's previous day", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-18T04:30:00.000Z") });
    await signInAtDesk(page);
    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    const session = await ensureOpenSession(page);
    expect(session, `the till would not open: ${session}`).toBe("open");

    const saved = await pool.query(
      "SELECT session_id, business_date::text AS day FROM ledger_till_sessions WHERE status = 'open'",
    );
    await pool.query("UPDATE ledger_till_sessions SET business_date = DATE '2026-10-17' WHERE status = 'open'");
    try {
      await page.reload();
      await landOnDesktop(page);
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await expect.poll(async () => page.evaluate(() => (window as unknown as { CDOS: { businessDate: () => string } }).CDOS.businessDate())).toBe("2026-10-17");
      await openCheques(page);
      await page.getByRole("button", { name: /Cash a cheque/i }).first().click();
      await expect(page.getByText(/Teller /).first()).toContainText("Oct 17, 2026");
      await expect(page.getByText("At risk until").locator("xpath=following-sibling::div[1]")).toHaveText("Oct 18, 2026");
    } finally {
      for (const row of saved.rows) {
        await pool.query(
          "UPDATE ledger_till_sessions SET business_date = $2::date WHERE session_id = $1",
          [row.session_id, String(row.day).slice(0, 10)],
        );
      }
    }
  });
});
