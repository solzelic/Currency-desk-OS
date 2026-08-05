/* ============================================================
   The currencies a desk deals in, from the screen to the book.

   This is a seam test in the sense docs/CASH_OWNERSHIP_INVARIANTS.md
   means it: the real Settings panel, driven in a real browser, against
   the real ledger, asserting the two agree afterwards. The server suite
   proves the routes and the migration; what it cannot prove is that the
   owner's screen reaches them and that the desk's answer changes.

   What used to be true, and is the whole reason this exists: the browser
   held `LEDGER_CCYS = ['CAD','USD','EUR','GBP']` and checked it BEFORE
   calling the server, so a shop holding pesos was refused by its own
   screen in words that blamed the ledger. The ledger, meanwhile, refused
   at the route with a four-way enum. Two copies of one rule, kept in
   step by hand, and neither of them anything a shop could change.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, rendered } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/** What the ledger says this desk deals in, asked from inside the page. */
const book = (page: Page) => ({
  currencies: () =>
    page.evaluate(() =>
      fetch("/api/ledger/desk-currencies").then((r) => r.json()),
    ),
  reset: () =>
    page.evaluate(() =>
      fetch("/api/ledger/desk-currencies", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currencies: null }),
      }).then((r) => r.status),
    ),
});

/* Settings has its own nav rail, and "Compliance" is also the name of an
   app in the top bar — clicking that one opens the Compliance desk OVER
   Settings, which looks exactly like the panel having vanished. Scoped to
   the rail, the same way desk-thresholds-seam.spec.ts does it. */
async function openSettings(page: Page) {
  await page.getByText(/^Settings$/i).first().click();
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();
  await rendered(page, /Currencies this desk deals in/i);
}

const field = (page: Page) => page.getByPlaceholder("Any currency");

test("the panel opens on what the ledger says, not on a local default", async ({
  page,
}) => {
  await signInAtDesk(page, "j.masri");
  expect(await book(page).reset()).toBe(200);
  await openSettings(page);

  /* Empty means "no set stated", which is not the same as a set with
     nothing in it — the desk may deal in anything the ledger carries,
     and the line under the field says so. */
  await expect(field(page)).toHaveValue("");
  await expect(page.getByText(/No set stated/i).first()).toBeVisible();
});

test("naming a set on screen is what the ledger then holds", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  expect(await book(page).reset()).toBe(200);
  await openSettings(page);

  await field(page).fill("PHP, INR");
  await field(page).press("Enter");

  /* THE SEAM. Not "the screen shows PHP" — the book was asked, and it is
     the book that decides what a teller may take at the counter. */
  await expect
    .poll(async () => (await book(page).currencies()).stated, { timeout: 15_000 })
    .toEqual(["CAD", "INR", "PHP"]);

  /* And the screen says what it now means, in the words a refusal will
     use. */
  await expect(page.getByText(/Trading/i).first()).toBeVisible();
});

test("clearing the field hands the question back rather than emptying the set", async ({
  page,
}) => {
  await signInAtDesk(page, "j.masri");
  await openSettings(page);
  await field(page).fill("USD");
  await field(page).press("Enter");
  await expect
    .poll(async () => (await book(page).currencies()).stated, { timeout: 15_000 })
    .toEqual(["CAD", "USD"]);

  await field(page).fill("");
  await field(page).press("Enter");
  /* null, not []. A desk that trades nothing is not a state any shop is
     in, and the difference is the whole reason removing the old
     four-currency enum did not just install a smaller one. */
  await expect
    .poll(async () => (await book(page).currencies()).stated, { timeout: 15_000 })
    .toBeNull();
  await expect(page.getByText(/No set stated/i).first()).toBeVisible();
});

test("a currency the ledger cannot carry is refused on the screen that named it", async ({
  page,
}) => {
  await signInAtDesk(page, "j.masri");
  expect(await book(page).reset()).toBe(200);
  await openSettings(page);

  await field(page).fill("USD, KWD");
  await field(page).press("Enter");

  /* Told here, with the reason, rather than discovered weeks later by a
     teller who cannot take a dinar with a customer in front of them. */
  await expect(page.getByText(/three decimal places/i).first()).toBeVisible({
    timeout: 15_000,
  });
  expect((await book(page).currencies()).stated).toBeNull();
});

test("a teller cannot reach the setting, and could not use it if they did", async ({
  page,
}) => {
  await signInAtDesk(page, "j.masri");
  expect(await book(page).reset()).toBe(200);

  await signInAtDesk(page, "a.singh");
  await page.getByText(/Rate Board/i).first().waitFor({ timeout: 45_000 });
  /* A teller has no Settings screen. That is a courtesy, not the
     protection — which is the next assertion. */
  await expect(page.getByText(/^Settings$/i)).toHaveCount(0);

  /* What actually protects the desk's currency set is the ledger saying
     no. Anybody signed in can call the route, so the route is what is
     driven here — the same shape as the reporting line, and for the same
     reason: a hidden control has never stopped anybody. */
  const refused = await page.evaluate(() =>
    fetch("/api/ledger/desk-currencies", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currencies: ["USD"] }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  );
  expect(refused.status).toBe(403);
  expect((await book(page).currencies()).stated).toBeNull();
});
