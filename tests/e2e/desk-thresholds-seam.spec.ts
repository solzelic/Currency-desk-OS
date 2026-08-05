/* ============================================================
   The reporting line, changed in a browser, enforced by the ledger.

   This is the seam the whole feature lives on. The owner's ask was that
   the thresholds work "not just at sign-up — I could also change those in
   the future". They already appeared to: the Settings rows accepted a
   number and the screens showed it. Nothing else in the product could
   see it. The number lived in one browser profile's saved state, so the
   second till at the same desk held its own copy, a cleared browser held
   none, and the ledger — which REFUSES a deal when the customer has not
   been identified — compared against a hardcoded 3,000 for every desk on
   earth, in a variable called `inputCad`.

   A server test proves the gate uses the resolved number. A browser test
   proves the control writes something. Neither can prove they are the
   same number, and that is precisely where every defect in this project
   has lived. So this file changes the line on the real screen, and then
   asks the ledger to post a deal on the wrong side of it.

   It also checks the sentence beside the control, because the second half
   of the ask was to be told where you stand — and because "stricter than
   FINTRAC requires" and "not compliant" are the two things that must
   never be confused with each other.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, rendered } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/** What the ledger says this desk's lines are, asked from inside the page. */
const thresholds = (page: Page) =>
  page.evaluate(() => fetch("/api/ledger/desk-thresholds").then((r) => r.json()));

/* Hand every line back to the jurisdiction pack — where a desk that has
   never touched this starts. Stated rather than assumed, because the seam
   database outlives a run and these tests undo each other's setup. */
const followThePack = (page: Page) =>
  page.evaluate(() =>
    fetch("/api/ledger/desk-thresholds", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reportThreshold: "pack_default",
        idThreshold: "pack_default",
        aggregationHours: "pack_default",
        retentionYears: "pack_default",
      }),
    }).then((r) => r.status),
  );

/* A till has to be open and stocked before anything can be posted against
   it, and the seam database outlives a run — other files close the session
   they opened. Both go through the product's own routes: setup that lies
   about how the product works is setup that stops catching it breaking.
   And both report what actually happened, because a fixture that fires and
   forgets is how a swallowed 500 passes for a passing test. */
async function deskCanTrade(page: Page) {
  const report = await page.evaluate(async (): Promise<string[]> => {
    const notes: string[] = [];
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status !== "open") {
      const opened = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      notes.push(opened.ok ? "session:open" : `session:${opened.status} ${await opened.text()}`);
    }
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    for (const [currency, wanted] of [["CAD", 60000], ["USD", 60000]] as const) {
      const have = Number(held.balances?.[currency] ?? 0);
      if (have >= wanted) continue;
      const answer = await fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `thr-topup-${currency}-${Date.now()}`,
          direction: "in",
          currency,
          amount: (wanted - have).toFixed(2),
          counterpartyType: "bank",
          counterpartyRef: "threshold-seam",
          reason: "Top-up so the threshold seam has a desk that can trade",
        }),
      });
      notes.push(answer.ok ? `${currency}:ok` : `${currency}:${answer.status} ${await answer.text()}`);
    }
    return notes;
  });
  /* Every step is asserted, not merely attempted. A drawer that failed to
     fill turns the deal below into a refusal for INSUFFICIENT_TILL_LIQUIDITY
     — which looks exactly like the compliance refusal this file is here to
     prove, and would pass. A fixture that fires and forgets is worse than
     no fixture. */
  const failed = report.filter((note) => !/:ok$|:open$/.test(note));
  expect(failed, `the desk could not be made ready: ${report.join(" · ")}`).toEqual([]);
  await page.reload();
  return report.join(" · ");
}

/* A customer nobody has identified. The identification gate is about
   exactly this person and nobody else, so the fixture states it rather
   than reusing whoever the last file left behind. */
async function walkInCustomer(page: Page) {
  const made = await page.evaluate(async () => {
    const answer = await fetch("/api/ledger/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalRef: `thr-seam-${Date.now()}`,
        name: "Threshold Seam Walk-in",
        risk: "normal",
        idStatus: "missing",
      }),
    });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  });
  expect(made.status, `creating the walk-in: ${JSON.stringify(made.body)}`).toBe(201);
  expect(made.body.customerId).toBeTruthy();
  return made.body.customerId as string;
}

/* Sell this customer `inputAmount` of Canadian dollars' worth of US
   dollars, through the two routes the New Transaction screen uses. Returns
   what the ledger said, never a bare boolean — the difference between
   "refused for compliance" and "refused because the drawer is empty" is
   the whole test. */
async function attemptDeal(page: Page, customerId: string, inputAmount: string, key: string) {
  return page.evaluate(
    async ([id, amount, idempotencyKey]) => {
      const quote = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: id,
          from: "CAD",
          to: "USD",
          inputAmount: amount,
          feeCad: "0.00",
          direction: "customer_buy_foreign",
        }),
      });
      if (!quote.ok) return { stage: "quote", status: quote.status, body: await quote.text() };
      const frozen = await quote.json();
      const posted = await fetch(`/api/quotes/${frozen.quoteId}/post`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          purpose: "Personal travel",
          sourceOfFunds: "Employment income",
        }),
      });
      return {
        stage: "post",
        status: posted.status,
        body: await posted.text(),
      };
    },
    [customerId, inputAmount, key],
  );
}

async function openComplianceSettings(page: Page) {
  await page.getByText(/^Settings$/i).first().click();
  /* Scoped to Settings' own nav rail. "Compliance" is also the name of an
     app in the top bar, and clicking that one opens the Compliance desk
     over the top of Settings — which looks like the setting has vanished. */
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();
  await rendered(page, /Large cash \/ reportable threshold/i);
}

/* The "Require ID over" money box. `^` anchors the filter to a container
   whose text STARTS with the title, which is the row rather than any
   ancestor that happens to contain it. */
const idBox = (page: Page) =>
  page
    .locator("div")
    .filter({ hasText: /^Require ID over/ })
    .first()
    .locator('input[inputmode="decimal"]')
    .first();

async function typeIdThreshold(page: Page, value: string) {
  const box = idBox(page);
  await box.click();
  await box.fill(value);
  await box.press("Enter");
}

test("the rows show the ledger's lines, not a local default", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  expect(await followThePack(page)).toBe(200);
  await openComplianceSettings(page);

  /* "unavailable" is what these rows render when they could not reach the
     route — including the way they could not reach it before, by fetching
     without the workspace header. A desk that is signed in and on the
     ledger must never see it. */
  await expect(page.getByText(/unavailable/i)).toHaveCount(0);

  const server = await thresholds(page);
  expect(server.regulator).toBe("FINTRAC");
  expect(server.reportThreshold.effective).toBe("10000.00");
  expect(server.idThreshold.effective).toBe("3000.00");

  // and the screen says where the number came from, in the pack's own words
  await expect(page.getByText(/Following FINTRAC \(\$?10,000/i).first()).toBeVisible();
});

test("tightening the line in Settings is what the ledger then refuses at", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  expect(await followThePack(page)).toBe(200);
  await deskCanTrade(page);
  const walkIn = await walkInCustomer(page);

  /* Under FINTRAC's 3,000 this deal is fine, and the ledger takes it.
     This is the control: without it, a refusal below could just as easily
     mean an empty drawer. */
  const before = await attemptDeal(page, walkIn, "2500.00", `thr-before-${Date.now()}`);
  expect(before.status, `first deal: ${before.stage} ${before.body}`).toBe(201);

  await openComplianceSettings(page);
  await typeIdThreshold(page, "1000");

  /* The server, not the screen. A box that held its own value and posted
     nothing would look exactly like this test passing. */
  await expect
    .poll(async () => (await thresholds(page)).idThreshold.effective, { timeout: 15_000 })
    .toBe("1000.00");
  expect((await thresholds(page)).idThreshold.posture).toBe("stricter");

  /* THE SEAM. Same customer, same shape of deal, an amount that FINTRAC
     would have let through and this desk has decided it will not. Before
     this change the ledger compared against a hardcoded 3,000 and posted
     it. */
  const after = await attemptDeal(page, walkIn, "2500.00", `thr-after-${Date.now()}`);
  expect(after.status, `refused deal: ${after.stage} ${after.body}`).toBe(422);
  expect(after.body).toContain("COMPLIANCE_BLOCKED");

  // and below the desk's new line it still trades, so the gate is a line
  // and not a wall
  const small = await attemptDeal(page, walkIn, "500.00", `thr-small-${Date.now()}`);
  expect(small.status, `small deal: ${small.stage} ${small.body}`).toBe(201);

  // put the desk back where it shipped
  expect(await followThePack(page)).toBe(200);
});

test("a stricter desk is told it is stricter, and a looser one that it is not compliant", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  expect(await followThePack(page)).toBe(200);
  await openComplianceSettings(page);

  /* Tighter than the mandate. A decision the desk made, usually because
     its bank asked — so it is a sentence and not an alarm. The words
     matter: this must not read as a fault. */
  await typeIdThreshold(page, "1000");
  await expect(page.getByText(/Stricter than FINTRAC requires/i).first()).toBeVisible();
  await expect(page.getByText(/Not compliant/i)).toHaveCount(0);

  /* Looser than the mandate. This desk is failing to report things it is
     legally obliged to report, and it has to be unmissable. */
  await typeIdThreshold(page, "9000");
  await expect
    .poll(async () => (await thresholds(page)).idThreshold.posture, { timeout: 15_000 })
    .toBe("looser");
  await expect(page.getByText(/Not compliant/i).first()).toBeVisible();

  expect(await followThePack(page)).toBe(200);
});

test("a teller cannot reach the rows, and could not use them if they did", async ({ page }) => {
  await signInAtDesk(page, "a.singh");
  await page.getByText(/Rate Board/i).first().waitFor({ timeout: 45_000 });

  // Settings is not a screen a teller has at all, so the rows are unreachable
  await expect(page.getByText(/^Settings$/i)).toHaveCount(0);

  /* And the route refuses them anyway. A hidden control is a courtesy, not
     a permission — anybody signed in can call the endpoint, so what
     actually protects the desk's reporting line is the server saying no. */
  const refused = await page.evaluate(() =>
    fetch("/api/ledger/desk-thresholds", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idThreshold: "50000.00" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  );
  expect(refused.status).toBe(403);
  expect((await thresholds(page)).idThreshold.deskChoice).toBeNull();
});
