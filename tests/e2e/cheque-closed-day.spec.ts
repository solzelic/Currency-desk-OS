/* A closed or signed-off day refuses a cheque return. The screen has to
   say so as a state, and it has to stop the three postings that the
   server will not take. Clearance stays available. */
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const REFUSAL = "This day is closed. Reversals and returns can't be posted to it.";
const NEXT_STEP =
  "Open a new session on the till that paid this cheque out, then reverse it there.";

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(async () => {
    const tour = (window as unknown as { CDOS_TOUR?: { record: Function } }).CDOS_TOUR;
    const ids = ["a.singh", "tnt-yorkfx:a.singh"];
    if (tour) ids.forEach((id) => tour.record(localStorage, id, "finished", "employee"));
    const persist = (window as unknown as { CDOS_PERSIST?: { save?: () => unknown } }).CDOS_PERSIST;
    if (persist && persist.save) await persist.save();
  });
  await expect(page.locator(".cdos-tour-skip")).toHaveCount(0);
}

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
  await landOnDesktop(page);
  return status;
}

async function ensureDrawerHas(page: Page, wanted: number) {
  return page.evaluate(async (want) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const have = Number(held.balances?.CAD ?? 0);
    if (have >= want) return "ok";
    const answer = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `chq-closed-topup-${Date.now()}`,
        direction: "in",
        currency: "CAD",
        amount: (want - have).toFixed(2),
        counterpartyType: "bank",
        counterpartyRef: "seam-fixture",
        reason: "Top-up so a closed-day cheque can be cashed",
      }),
    });
    return answer.ok ? "ok" : `${answer.status} ${await answer.text()}`;
  }, wanted);
}

async function closeOpenSession(page: Page) {
  return page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const sessionId = current.session && current.session.sessionId;
    if (!sessionId) return "no session";
    const closed = await fetch(`/api/ledger/till-sessions/${sessionId}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `chq-closed-day-${Date.now()}`,
        counts: held.balances,
        note: "Signed off",
        balanceGeneration: held.balanceGeneration,
      }),
    });
    return closed.ok ? "ok" : `${closed.status} ${await closed.text()}`;
  });
}

test("a closed day disables return, fraud and reversal and shows the next step", async ({ page }) => {
  await signInAtDesk(page);
  await dismissTour(page);

  const session = await ensureOpenSession(page);
  expect(session, `the till would not open: ${session}`).toBe("open");
  await dismissTour(page);
  const topUp = await ensureDrawerHas(page, 6000);
  expect(topUp, `the drawer could not be topped up: ${topUp}`).toBe("ok");

  await page.getByText(/^Cheques$/).first().click();
  await expect(page.getByText(/Cheque clearing/i).first()).toBeVisible();
  await page.getByRole("button", { name: /Cash a cheque/i }).first().click();

  const number = String(Date.now()).slice(-6);
  await page.getByPlaceholder("Type a name…").fill("Closed Day Customer");
  await page.getByRole("button", { name: /^Payroll$/ }).click();
  await page.getByPlaceholder("0.00").fill("1200");
  await page.getByPlaceholder("e.g. 004821").fill(number);
  await page.getByPlaceholder("Payer name / business").fill("Maple Payroll Services");
  await page.getByPlaceholder("e.g. RBC Royal Bank").fill("Scotiabank");
  await page.getByRole("button", { name: /Cash & hold/i }).click();

  const returnNsf = page.getByRole("button", { name: "Return NSF" });
  const flagFraud = page.getByRole("button", { name: "Flag fraud" });
  const reverse = page.getByRole("button", { name: "Reverse cashing" });
  await expect(returnNsf).toBeVisible();
  await expect(returnNsf).toBeEnabled();

  const closed = await closeOpenSession(page);
  expect(closed, `the day would not close: ${closed}`).toBe("ok");

  await returnNsf.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(REFUSAL);
  await expect(alert).toContainText(NEXT_STEP);
  await expect(returnNsf).toBeDisabled();
  await expect(flagFraud).toBeDisabled();
  await expect(reverse).toBeDisabled();
  await expect(page.getByRole("button", { name: /Mark cleared/ })).toBeEnabled();

  for (const button of [returnNsf, flagFraud, reverse]) {
    const box = await button.boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(44);
  }
});
