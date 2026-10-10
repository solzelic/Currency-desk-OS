/* ============================================================
   One key per opened cash-move form.

   The Move cash form, the vault's "issue to till" form, and the
   wholesale delivery form used to build an idempotency key from the
   clock plus a random tail at the moment of the tap. The server
   replays a key it has already recorded, so a retry under a NEW key
   is a second movement. A tap whose answer never came back, followed
   by another tap on the same form, paid the money twice.

   Each test lets the first post commit, then tells the browser the
   answer was lost, then submits that same form again. The till or
   the vault may move once.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const FLOAT = 40;

/** A currency the ledger has no row for has not been moved yet. */
function held(balances: Record<string, string> | undefined, currency: string) {
  const raw = balances?.[currency];
  return raw == null || raw === "" ? 0 : Number(raw);
}

async function prepareDesk(page: Page) {
  await signInAtDesk(page);
  const book = ledger(page);
  const ready = await page.evaluate(async () => {
    const vault = await fetch("/api/ledger/vault").then((r) => r.json());
    if (!vault.tracked) {
      const opened = await fetch("/api/ledger/vault/opening-position", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { CAD: "80000.00", USD: "20000.00", EUR: "10000.00" } }),
      });
      if (!opened.ok && opened.status !== 409) {
        return `vault ${opened.status} ${await opened.text()}`;
      }
    }
    const session = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (session.session?.status !== "open") {
      const opened = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!opened.ok && opened.status !== 409) {
        return `till ${opened.status} ${await opened.text()}`;
      }
    }
    return "ok";
  });
  expect(ready).toBe("ok");
  return book;
}

/** Let the first POST commit, and tell the browser it never arrived. */
async function loseFirstResponse(page: Page, urlPart: string) {
  const posts: { key: string; status: number }[] = [];
  let dropped = false;
  await page.route(`**${urlPart}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { idempotencyKey?: string };
    const key = String(body.idempotencyKey ?? "");
    const response = await route.fetch();
    posts.push({ key, status: response.status() });
    if (!dropped && response.ok()) {
      dropped = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "The response was lost." }),
      });
      return;
    }
    await route.fulfill({ response });
  });
  return posts;
}

async function restoreTill(page: Page, currency: string, before: number) {
  const after = held(await ledger(page).till(), currency);
  const delta = Math.round((after - before) * 100) / 100;
  if (!delta) return;
  const restored = await page.evaluate(
    async ({ currency, delta }) => {
      const response = await fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `seam-restore-${currency}-${delta}-${Date.now()}`,
          direction: delta > 0 ? "out" : "in",
          currency,
          amount: Math.abs(delta).toFixed(2),
          counterpartyType: "vault",
          counterpartyRef: "seam-restore",
          reason: "Put the seam drawer back",
        }),
      });
      return response.status;
    },
    { currency, delta },
  );
  expect(restored).toBe(201);
}

test("a lost answer on Move cash does not float the drawer twice", async ({ page }) => {
  const book = await prepareDesk(page);
  const before = held(await book.till(), "CAD");
  const posts = await loseFirstResponse(page, "/api/ledger/till-movements");

  await page.getByText(/Cash Drawer/i).first().click();
  await page.getByRole("button", { name: /^Move cash$/i }).first().click();
  await page.locator('input[placeholder="0"]').last().fill(String(FLOAT));
  const submit = page.getByRole("button", { name: /Issue float/i }).last();
  await submit.click();
  await expect(page.getByText(/The response was lost/i)).toBeVisible();

  await submit.click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(posts.every((post) => post.status === 201)).toBe(true);
  expect(new Set(posts.map((post) => post.key)).size).toBe(1);
  expect(held(await book.till(), "CAD")).toBe(before + FLOAT);

  await restoreTill(page, "CAD", before);
});

test("a lost answer on Issue to till does not float the drawer twice", async ({ page }) => {
  const book = await prepareDesk(page);
  const before = held(await book.till(), "CAD");
  const posts = await loseFirstResponse(page, "/api/ledger/till-movements");

  await page.getByText(/Cash on Hand/i).first().click();
  await page.getByRole("button", { name: /^Floats$/ }).first().click();
  await page.getByRole("button", { name: /^Assign$/ }).first().click();
  await page.getByRole("button", { name: /To a till/i }).click();
  await page.getByRole("spinbutton").first().fill(String(FLOAT));
  const submit = page.getByRole("button", { name: /Issue to till/i });
  await submit.click();
  await expect(page.getByText(/The response was lost/i)).toBeVisible();

  await submit.click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(posts.every((post) => post.status === 201)).toBe(true);
  expect(new Set(posts.map((post) => post.key)).size).toBe(1);
  expect(held(await book.till(), "CAD")).toBe(before + FLOAT);

  await restoreTill(page, "CAD", before);
});

test("a lost answer on a wholesale delivery does not credit the vault twice", async ({ page }) => {
  const book = await prepareDesk(page);
  const before = held((await book.vault()).balances, "USD");
  const posts = await loseFirstResponse(page, "/api/ledger/vault/receipts");

  await page.getByText(/Cash on Hand/i).first().click();
  await page.getByRole("button", { name: /^Order$/ }).first().click();
  await page.getByRole("button", { name: /Cash is already in hand/i }).click();
  await page.getByRole("spinbutton").nth(0).fill("100");
  await page.getByRole("spinbutton").nth(1).fill("130");

  const submit = page.getByRole("button", { name: /Confirm received/i });
  await submit.click();
  await expect(page.getByText(/The response was lost/i)).toBeVisible({ timeout: 15_000 });

  await submit.click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(posts.every((post) => post.status === 201)).toBe(true);
  expect(new Set(posts.map((post) => post.key)).size).toBe(1);
  expect(held((await book.vault()).balances, "USD")).toBe(before + 100);
});
