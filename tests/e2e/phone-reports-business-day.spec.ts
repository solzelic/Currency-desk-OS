/* The sheet's day is the branch's, not the browser's.

   The browser is in Jerusalem, where this instant is 4:00 AM on
   Oct 13. The branch is in Toronto, where it is 9:00 PM on Oct 12.
   The sheet, the large-cash count, and the PDF follow Toronto. */
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");
test.use({ timezoneId: "Asia/Jerusalem" });

const AT = "2026-10-13T01:00:00.000Z";

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

test("9 PM in Toronto is still Oct 12 when the browser is in Jerusalem", async ({ page }) => {
  test.setTimeout(180_000);
  await page.clock.install({ time: new Date(AT) });
  await page.route("**/*", async (route) => {
    const headers = { ...route.request().headers(), "x-cd-now": AT };
    await route.continue({ headers });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "j.masri");
  await dismissTour(page);
  const opened = await page.evaluate(async () => {
    const key = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random());
    const tillId = "till-toronto-" + key().slice(0, 8);
    const response = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tillId }),
    });
    const body = await response.json().catch(() => ({}));
    const id = body.workspaceId || (body.till && body.till.workspaceId);
    if (!id) return "no till " + response.status + " " + JSON.stringify(body);
    await window.CDOS.Backend.selectWorkspace(id);
    window.CDOS.Backend.setWorkspace(id);
    /* Raw fetch does not send the desk's workspace header. The clock
       route must not be the thing that picks which till was opened. */
    const headers = { "content-type": "application/json", "x-workspace-id": id };
    const session = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: "{}",
    });
    if (!session.ok && session.status !== 409) return "open " + session.status + " " + await session.text();
    const topped = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        idempotencyKey: "toronto-topup-" + key(),
        direction: "in",
        currency: "USD",
        amount: "20000.00",
        counterpartyType: "bank",
        counterpartyRef: "toronto-night",
        reason: "Stock for the 9 PM large-cash deal",
      }),
    });
    if (!topped.ok) return "topup " + topped.status + " " + await topped.text();
    /* An inflow still needs a balance row. CAD arrives with the deal;
       the row has to exist before that update can land. */
    const cad = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        idempotencyKey: "toronto-cad-" + key(),
        direction: "in",
        currency: "CAD",
        amount: "100.00",
        counterpartyType: "bank",
        counterpartyRef: "toronto-night",
        reason: "Open the CAD row so the large-cash pay-in can land",
      }),
    });
    if (!cad.ok) return "cad " + cad.status + " " + await cad.text();
    const made = await fetch("/api/ledger/customers", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        externalRef: "toronto-" + key(),
        name: "Toronto Night",
        risk: "normal",
        idStatus: "verified",
      }),
    });
    const customer = await made.json().catch(() => ({}));
    if (!made.ok || !customer.customerId) return "customer " + made.status + " " + JSON.stringify(customer);
    const quote = await fetch("/api/quotes", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        customerId: customer.customerId,
        from: "CAD",
        to: "USD",
        inputAmount: "10000.00",
        feeCad: "4.00",
        direction: "customer_buy_foreign",
      }),
    });
    if (!quote.ok) return "quote " + quote.status + " " + await quote.text();
    const frozen = await quote.json();
    const posted = await fetch("/api/quotes/" + frozen.quoteId + "/post", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        idempotencyKey: "toronto-10000-" + key(),
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
      }),
    });
    if (!posted.ok) return "post " + posted.status + " " + await posted.text();
    const close = await window.CDOS.Backend.loadCloseOfDay();
    const snap = close.preview;
    return snap
      ? { date: snap.businessDate, zone: snap.timeZone, single: snap.singleDeals, line: snap.reportingLine }
      : "no preview";
  });
  if (typeof opened === "string") throw new Error(opened);
  expect(opened.zone).toBe("America/Toronto");
  expect(opened.date).toBe("2026-10-12");
  expect(opened.single).toBe(1);
  expect(opened.line).toBe("10000.00");

  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="reports"]').click();
  await dismissTour(page);
  const home = page.locator("[data-reports-home]");
  await expect(home).toBeVisible();
  await expect(home).toContainText("Oct 12, 2026");
  await expect(home).not.toContainText("Oct 13");
  await home.getByRole("button", { name: "See the full sheet" }).click();
  const sheet = page.locator("[data-reports-sheet]");
  await expect(sheet).toContainText("Oct 12, 2026");
  await expect(sheet).not.toContainText("Oct 13");
  const large = sheet.locator(".stat", { hasText: "Large cash deals" });
  await expect(large).toContainText(String(opened.single));
  await expect(large).toContainText("10,000 CAD or more");

  await page.locator("[data-reports-save]").click();
  await page.getByRole("button", { name: "Save without a count" }).click();
  await expect(page.locator("[data-reports-toast]")).toBeVisible();
  const pdf = await page.evaluate(async () => {
    const response = await fetch("/api/ledger/close-of-day/pdf", { credentials: "same-origin" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, text: new TextDecoder("latin1").decode(bytes) };
  });
  expect(pdf.status).toBe(200);
  expect(pdf.text.startsWith("%PDF")).toBe(true);
  expect(pdf.text).toContain("Oct 12, 2026");
  expect(pdf.text).toContain("9:00 PM");
  expect(pdf.text).not.toContain("Oct 13");
  expect(pdf.text).toContain("Teller");
  expect(pdf.text).toContain("Owner");
  expect(pdf.text).toContain("/MediaBox [0 0 595 842]");
});
