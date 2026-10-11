/* ============================================================
   ID on file, through the till.

   The posting gate reads the client the ledger row points at. The
   till used to sync a customer under os:<slug> and leave client_id
   empty, so a passport on the file never reached the gate: the desk
   said ID on file, the checklist said READY, and 3,000 CAD was
   refused. This walk does the thing a teller does.

   An identified client posts. A client with no document does not,
   and the screen says so in the words the server uses, with a way
   to record the ID. A paid verify check is not that way: Persona
   is not connected.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, rendered } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const IDENTIFIED = `Nadia Passport ${RUN}`;
const NO_ID = `No Id Client ${RUN}`;
const NO_ID_REASON = "No ID on file";

async function ensureTill(page: Page) {
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
  expect(status).toBe("open");
  /* The customer hands over Canadian dollars and takes US dollars, so
     the drawer has to hold the currency it will pay out. */
  const topped = await page.evaluate(async () => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const want: Record<string, number> = { CAD: 5000, USD: 5000 };
    const notes: string[] = [];
    for (const [currency, amount] of Object.entries(want)) {
      const have = Number(held.balances?.[currency] ?? 0);
      if (have >= amount) { notes.push(`${currency}:enough`); continue; }
      const answer = await fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `id-seam-${currency}-${Date.now()}`,
          direction: "in",
          currency,
          amount: (amount - have).toFixed(2),
          counterpartyType: "bank",
          counterpartyRef: "id-on-file-seam",
          reason: "Top-up so an identified client can post 3000 CAD",
        }),
      });
      notes.push(answer.ok ? `${currency}:topped` : `${currency}:${answer.status} ${await answer.text()}`);
    }
    return notes.join(" ");
  });
  expect(topped, topped).toMatch(/CAD:(enough|topped)/);
  expect(topped, topped).toMatch(/USD:(enough|topped)/);
}

async function seedClients(page: Page) {
  return page.evaluate(async ({ identified, noId }) => {
    const call = async (url: string, body: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const nadia = await call("/api/clients", { legalName: identified, kind: "individual" });
    if (nadia.status !== 201) return { ok: false, step: "create-nadia", nadia };
    const passport = await call(`/api/clients/${nadia.body.clientId}/documents`, {
      docType: "Passport",
      docNumber: "P7712345",
      expiresOn: "2031-05-01",
    });
    const walker = await call("/api/clients", { legalName: noId, kind: "individual" });
    return { ok: passport.status === 201 && walker.status === 201, nadia, passport, walker };
  }, { identified: IDENTIFIED, noId: NO_ID });
}

async function openNewTransaction(page: Page) {
  const tour = page.locator(".cdos-tour-skip");
  if (await tour.isVisible().catch(() => false)) await tour.click();
  await page.getByText(/^Ledger$/).first().click();
  const deal = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(deal).toBeEnabled({ timeout: 30_000 });
  await deal.click();
  const form = page.locator("div.fixed.inset-0").filter({ has: page.getByText("Customer pays in") });
  await expect(form).toBeVisible();
  return form;
}

async function pickCustomer(page: Page, form: ReturnType<Page["locator"]>, name: string) {
  const box = form.getByPlaceholder("Type a name…");
  await box.click();
  await box.fill(name);
  /* The typed name also sits inside "Add new client …", and a
     substring match clicks that instead of the file. The customer's
     own row is the button whose name starts with the name. */
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const option = form.getByRole("button", { name: new RegExp(`^${escaped}\\b`) });
  await expect(option).toBeVisible();
  await option.click();
}

test("an identified client posts 3000 CAD, and a client with no ID is told to record it", async ({ page }) => {
  await signInAtDesk(page);
  await ensureTill(page);
  await page.reload();
  await landOnDesktop(page);
  const seeded = await seedClients(page);
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);

  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await rendered(page, new RegExp(IDENTIFIED));
  await expect(page.getByText(NO_ID).first()).toBeVisible();

  const form = await openNewTransaction(page);
  await pickCustomer(page, form, IDENTIFIED);
  await form.locator('input[placeholder="0.00"]').first().fill("3000");
  await form.getByPlaceholder("e.g. vacation funds, invoice settlement").fill("Travel");
  await form.getByPlaceholder("e.g. employment income, savings").fill("Salary");
  await expect(form.getByText("READY")).toBeVisible();
  /* An array, not a Set: the value comes back across the browser
     boundary, and a Set does not survive that. */
  const beforeIds = await page.evaluate(async () => {
    const body = await fetch("/api/ledger/transactions?limit=200").then((r) => r.json());
    return ((body.transactions || []) as { transactionId: string }[]).map((row) => row.transactionId);
  });
  const before = new Set(beforeIds);
  await form.getByRole("button", { name: "Get server quote" }).click();
  const post = form.getByRole("button", { name: "Post frozen quote" });
  await expect(post).toBeEnabled({ timeout: 20_000 });
  await post.click();
  await expect
    .poll(async () => {
      const body = await page.evaluate(() => fetch("/api/ledger/transactions?limit=200").then((r) => r.json()));
      const rows = (body.transactions || []) as { transactionId: string; inputAmount?: string; from?: string }[];
      return rows.some((row) => !before.has(row.transactionId) && Number(row.inputAmount) === 3000 && row.from === "CAD");
    }, { timeout: 20_000 })
    .toBe(true);

  const again = await openNewTransaction(page);
  await pickCustomer(page, again, NO_ID);
  await again.locator('input[placeholder="0.00"]').first().fill("3000");
  await again.getByPlaceholder("e.g. vacation funds, invoice settlement").fill("Travel");
  await again.getByPlaceholder("e.g. employment income, savings").fill("Salary");
  await expect(again.getByText(NO_ID_REASON)).toBeVisible();
  await expect(again.getByText("READY")).toHaveCount(0);
  await expect(again.getByText(/Run verify check/)).toHaveCount(0);
  await again.getByTestId("record-id").click();
  await expect(page.getByTestId("id-entry")).toBeVisible();
  await expect(page.getByText("Add ID").first()).toBeVisible();
});
