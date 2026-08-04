/* ============================================================
   The costing switch, in a real browser, against the real ledger.

   This setting is unlike everything else on the Settings screen: the rest
   write the browser's saved preferences, and this one changes what the
   book reports as profit. So the two things worth proving in a browser are
   that it reads the SERVER's answer rather than a local default, and that
   flipping it moves the ledger — not a checkbox that looks flipped.

   It is also the row most likely to break silently. It talks to a ledger
   route, every ledger route decides which till it is answering for from a
   header the Backend client sets, and a control that fetched for itself
   would show "unavailable" on any desk with two tills while nothing at all
   was wrong. A green unit test cannot see that; this can.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, rendered } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/** What the ledger says the desk costs by, asked from inside the page. */
const costMethod = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    fetch("/api/ledger/cost-method").then((r) => r.json()),
  );

/* Hand the decision back to the jurisdiction pack, which is where a desk
   that has never touched this starts. Stated rather than assumed: the
   database outlives a run, and "nobody has chosen yet" is a precondition
   these tests can undo for each other. The switch itself cannot express
   it — it flips between two methods — so this goes through the route. */
const followThePack = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    fetch("/api/ledger/cost-method", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "pack_default" }),
    }).then((r) => r.status),
  );

async function openCostingSetting(page: import("@playwright/test").Page) {
  await page.getByText(/^Settings$/i).first().click();
  /* Scoped to Settings' own nav rail. "Cash on hand · Vault" is also the
     name of an app in the top bar, and clicking that one opens the Vault
     over the top of Settings — which looks like the setting has vanished. */
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Cash on hand · Vault/i)
    .first()
    .click();
  await rendered(page, /Cost stock first-in, first-out/i);
}

/* The switch itself, not the row's explainer button. `^` anchors the filter
   to a container whose text STARTS with the title, which is the row rather
   than any ancestor that happens to contain it. */
const toggle = (page: import("@playwright/test").Page) =>
  page
    .locator("div")
    .filter({ hasText: /^Cost stock first-in, first-out/ })
    .first()
    .locator("button.w-11")
    .first();

test("the switch shows what the ledger says, not a local default", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  expect(await followThePack(page)).toBe(200);
  await openCostingSetting(page);

  /* "unavailable" is what this row renders when it could not reach the
     route — including the way it could not reach it before, by fetching
     without the workspace header. A desk that is signed in and on the
     ledger must never see it. */
  await expect(page.getByText(/unavailable/i)).toHaveCount(0);

  const server = await costMethod(page);
  expect(server.method).toBe("weighted_average");
  // and it says so out loud while the desk has not chosen for itself
  await expect(
    page.getByText(/Following your jurisdiction.s suggestion/i),
  ).toBeVisible();
});

test("a manager turns it on and the ledger is what changed", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  await openCostingSetting(page);
  expect((await costMethod(page)).method).toBe("weighted_average");

  await toggle(page).click();

  /* The server, not the screen. A toggle that flipped its own state and
     posted nothing would look exactly like this test passing. */
  await expect
    .poll(async () => (await costMethod(page)).method, { timeout: 15_000 })
    .toBe("fifo");
  await expect(
    page.getByText(/Following your jurisdiction.s suggestion/i),
  ).toHaveCount(0);

  // and it survives a reload, because it was never browser state
  await page.reload();
  await openCostingSetting(page);
  expect((await costMethod(page)).entityChoice).toBe("fifo");

  // put it back the way the desk shipped: undecided, following the pack
  expect(await followThePack(page)).toBe(200);
  expect((await costMethod(page)).entityChoice).toBeNull();
});

test("a teller cannot reach the setting, and could not use it if they did", async ({ page }) => {
  await signInAtDesk(page, "a.singh");
  await page.getByText(/Rate Board/i).first().waitFor({ timeout: 45_000 });

  // Settings is not a screen a teller has at all, so the switch is unreachable
  await expect(page.getByText(/^Settings$/i)).toHaveCount(0);

  /* And the route refuses them anyway. A hidden control is a courtesy, not
     a permission — anybody signed in can call the endpoint, so what actually
     protects the book has to be the server saying no. */
  const refused = await page.evaluate(() =>
    fetch("/api/ledger/cost-method", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "fifo" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  );
  expect(refused.status).toBe(403);
  expect((await costMethod(page)).method).toBe("weighted_average");
});
