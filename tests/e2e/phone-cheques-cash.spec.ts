/* Phone Cheques. At 360 and 390 a cashier sees the two cards, the
   chips, and can cash a cheque. A double tap posts once. The cash
   to hand over on the screen is the net the ledger stored.
   At 1280 the Cheques window is the desktop window. The 1280
   picture is store evidence only. It is not a desktop baseline. */
import { existsSync, mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const PHONE = { height: 844 };

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

async function ensureOpenSession(page: Page): Promise<string> {
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
  await landOnDesktop(page);
  return status;
}

async function ensureDrawerHas(page: Page, wanted: number): Promise<string> {
  return page.evaluate(async (want) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const have = Number(held.balances?.CAD ?? 0);
    if (have >= want) return "ok";
    const answer = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `phq-topup-${Date.now()}`,
        direction: "in",
        currency: "CAD",
        amount: (want - have).toFixed(2),
        counterpartyType: "bank",
        counterpartyRef: "phone-cheques",
        reason: "Top-up so the phone cheque test has cash to hand over",
      }),
    });
    return answer.ok ? "ok" : `${answer.status} ${await answer.text()}`;
  }, wanted);
}

async function openPhoneCheques(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: PHONE.height });
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page);
  await dismissTour(page);
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="cheques"]').click();
  await expect(page.locator('[data-phone-shell][data-app="cheques"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cheques" })).toBeVisible();
}

function book(page: Page) {
  return {
    cheques: () => page.evaluate(async () => {
      const answer = await fetch("/api/ledger/cheques?limit=200");
      if (!answer.ok) throw new Error(`${answer.status} ${await answer.text()}`);
      return (await answer.json()).cheques ?? [];
    }),
  };
}

/* The same shape formatPhoneMoney prints for Canadian dollars. */
function cad(amount: string): string {
  const n = Number(amount);
  const body = new Intl.NumberFormat("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return (n < 0 ? "\u2212" : "") + body + " CAD";
}

for (const width of [360, 390]) {
  test(`cards, chips, and one cashing at ${width}`, async ({ page }) => {
    await openPhoneCheques(page, width);
    await expect(page.getByText("Example data")).toHaveCount(0);
    await expect(page.locator("#phone-fab")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Paid, not cleared yet/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Bounced this month/ })).toBeVisible();
    for (const label of ["All", "On hold", "Cleared", "Returned"]) {
      await expect(page.getByRole("tab", { name: new RegExp("^" + label + " ") })).toBeVisible();
    }
    await expect(page.getByRole("tab", { name: /^All / })).toHaveAttribute("aria-selected", "true");
    if (width === 360) {
      await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
      await phoneSweep(page, { roots: ['[data-phone-shell][data-app="cheques"]'] });
      await page.setViewportSize({ width, height: PHONE.height });
    }
    await page.getByRole("button", { name: /Paid, not cleared yet/ }).click();
    await expect(page.getByRole("tab", { name: /^On hold / })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: /Bounced this month/ }).click();
    await expect(page.getByRole("tab", { name: /^Returned / })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /^All / }).click();

    const session = await ensureOpenSession(page);
    expect(session, `the till would not open: ${session}`).toBe("open");
    const topped = await ensureDrawerHas(page, 6000);
    expect(topped, `the drawer could not be topped up: ${topped}`).toBe("ok");
    await dismissTour(page);
    await page.locator('#phonebar [data-phone-app="more"]').click();
    await page.locator('#phone-more [data-phone-app="cheques"]').click();
    await expect(page.locator('[data-phone-shell][data-app="cheques"]')).toBeVisible();

    const before = (await book(page).cheques()).length;
    const number = `P${width}${String(Date.now()).slice(-6)}`;
    await page.getByRole("button", { name: "Cash a cheque", exact: true }).click();
    await page.getByLabel("Customer").fill("Priya Nair");
    /* A customer already on the book is a pick. A new name is
       "Use “Priya Nair”". Either one selects her. */
    await page.locator(".phq-pick").filter({ hasText: "Priya Nair" }).first().click();
    await page.getByRole("option", { name: /Payroll/ }).click();
    await expect(page.getByRole("option", { name: /Payroll/ })).toContainText(/2\.0%, 1 day hold/);
    await page.getByLabel("Cheque amount").fill("1240");
    const give = page.locator('[data-phone-cheque="give"]');
    await expect(give).toHaveText("1,215.20 CAD");
    if (width === 360) {
      await phoneSweep(page, { roots: [".phq-sheet"] });
      await page.setViewportSize({ width, height: PHONE.height });
    }
    const sheet = page.locator(".phq-sheet");
    await expect(sheet.getByText("Our fee (2.0%)")).toBeVisible();
    await expect(sheet.getByText("24.80 CAD", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Next: cheque details" }).click();
    await page.getByLabel("Cheque number", { exact: true }).fill(number);
    await page.getByLabel("Who wrote the cheque").fill("Northbridge Payroll");
    await page.getByLabel("Bank").fill("RBC");
    const signed = page.getByRole("switch", { name: "Signed on the back" });
    await expect(signed).toHaveAttribute("aria-checked", "false");
    await signed.getByText("Signed on the back").click();
    await expect(signed).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Next: check and pay" }).click();
    await expect(give).toHaveText("1,215.20 CAD");

    let posts = 0;
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (req.method() === "POST" && url.pathname === "/api/ledger/cheques") posts += 1;
    });
    await page.locator('[data-phone-cheque="pay"]').evaluate((btn: HTMLButtonElement) => {
      btn.click();
      btn.click();
    });

    await expect(page.getByRole("status").filter({ hasText: "Cheque cashed. Give Priya 1,215.20 CAD." })).toBeVisible({ timeout: 20_000 });
    expect(posts, "a double tap must post the cashing once").toBe(1);

    const cheques = await book(page).cheques();
    expect(cheques).toHaveLength(before + 1);
    const cashed = cheques.find((c: { chequeNumber: string }) => c.chequeNumber === number);
    expect(cashed, "the cheque is not on the ledger").toBeTruthy();
    expect(cashed.faceAmount).toBe("1240.00");
    expect(cashed.feeAmount).toBe("24.80");
    expect(cashed.netAmount).toBe("1215.20");
    expect(cashed.status).toBe("held");
    expect(cad(cashed.netAmount)).toBe("1,215.20 CAD");
    const shell = page.locator('[data-phone-shell][data-app="cheques"]');
    await expect(shell.getByRole("button", { name: /Priya Nair/ }).first()).toBeVisible();
    await expect(shell.getByText("Cheque 1,240.00 CAD").first()).toBeVisible();
    await expect(shell.getByText("Paid 1,215.20 CAD").first()).toBeVisible();
  });
}

test("desktop Cheques at 1280 is the desktop screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await dismissTour(page);
  await page.getByText(/^Cheques$/).first().click();
  await expect(page.getByText(/Cheque clearing/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-phone-shell][data-app="cheques"]')).toHaveCount(0);
  await expect(page.locator(".phq-sheet")).toHaveCount(0);
  await expect(page.getByText("Example data")).toHaveCount(0);
  const desk = page.locator(".win.show.active").first();
  await expect(desk.getByRole("button", { name: /Cash a cheque/ }).first()).toBeVisible();
  await expect(desk.getByRole("button", { name: /Fee schedule/ })).toBeVisible();
  /* Store evidence of the desktop window. desktop-unchanged keeps
     its own baselines; this file does not add one. */
  if (existsSync("/cursor/stores")) {
    mkdirSync("/cursor/stores/self/pr118", { recursive: true });
    await page.screenshot({ path: "/cursor/stores/self/pr118/desktop_1280.png" });
  }
});
