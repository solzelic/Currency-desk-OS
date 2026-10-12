/* While ID checks are not connected, the label comes from the
   document. A stored verification_status of verified does not
   change it. The SQL here plants that old word. The product does
   not write it. */
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, ledger } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no client records");

/* Playwright compiles this file to CommonJS, so import.meta is not
   available. The parent path is the repo package, and the alias list
   is resolved from there. */
const aliasRequire = createRequire(path.join(process.cwd(), "package.json"));
const { isHealthCardType } = aliasRequire("./os-src/health-card-aliases.js") as {
  isHealthCardType: (value: unknown) => boolean;
};
const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: { verification_status: string }[]; rowCount: number | null }>;
    end: () => Promise<void>;
  };
};

const shots = "/opt/cursor/artifacts/screenshots";
const pr100Shots = "/opt/cursor/artifacts/pr100";
let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function openTeller(page: Page) {
  await signInAtDesk(page, "m.costa");
  const ready = await page.evaluate(() => typeof (window as any).CDOS?.displayIdStanding === "function");
  expect(ready, "rebuild web/app/os.js — the desk has no displayIdStanding").toBe(true);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
}

async function createClient(page: Page, legalName: string) {
  const created = await page.evaluate(async (name) => {
    const response = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName: name, kind: "individual" }),
    });
    return { status: response.status, body: await response.json() };
  }, legalName);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.clientId as string;
}

async function addPassport(page: Page, clientId: string, expiresOn: string) {
  const documented = await page.evaluate(async ({ id, expiresOn }) => {
    const response = await fetch(`/api/clients/${id}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "Passport", docNumber: "P-STORED-1", source: "staff", expiresOn }),
    });
    return { status: response.status, body: await response.json() };
  }, { id: clientId, expiresOn });
  expect(documented.status, JSON.stringify(documented.body)).toBe(201);
}

async function storeVerified(clientId: string) {
  const planted = await pool.query(
    `UPDATE desk_clients SET verification_status = 'verified' WHERE client_id = $1 RETURNING verification_status`,
    [clientId],
  );
  expect(planted.rowCount).toBe(1);
}

async function openProfile(page: Page, name: string) {
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await expect(page.getByRole("button", { name: /^Identified/ }).first()).toBeVisible();
  await page.getByPlaceholder("Search name, phone, or a file on their record…").fill(name);
  const card = page.locator('div[role="button"]').filter({ hasText: name }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  return card;
}

async function shoot(page: Page, standing: ReturnType<Page["getByTestId"]>, stem: string) {
  if (!existsSync("/opt/cursor/artifacts")) return;
  mkdirSync(shots, { recursive: true });
  await standing.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1280, height: 800 });
  await standing.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/${stem}-1280.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await standing.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/${stem}-390.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
}

/* The chip uses the same helper as the card. A warning label is
   not in Identified, and it is still on the full list. */
async function expectChipFilter(page: Page, name: string, label: string) {
  const clients = page.locator("div.win").filter({ has: page.getByPlaceholder("Search name, phone, or a file on their record…") });
  const card = clients.locator('div[role="button"]').filter({ hasText: name });
  await clients.getByRole("button", { name: /^Identified/ }).click();
  if (label === "Identified") {
    await expect(card.first()).toBeVisible();
    await expect(card.first()).toContainText("Identified");
  } else {
    await expect(card).toHaveCount(0);
  }
  await clients.getByRole("button", { name: /^All\s*\d/ }).click();
  await expect(card.first()).toContainText(label);
  if (label !== "Identified") expect(await card.first().innerText()).not.toContain("Identified");
}

/* The deal picker is the other place a cashier reads this label.
   It calls displayIdStanding. A cashier cannot generate the KYC
   register; that sheet is the manager test below. */
async function expectSameLabelElsewhere(page: Page, name: string, label: string) {
  const close = page.getByRole("button", { name: "Close" });
  if (await close.isVisible().catch(() => false)) await close.click();

  const opened = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return res.ok || res.status === 409 ? "open" : `${res.status}`;
  });
  expect(opened, "the till did not open").toBe("open");
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  await page.getByText(/^Ledger$/).first().click();
  const newDeal = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(newDeal).toBeEnabled({ timeout: 30_000 });
  await newDeal.click();
  const form = page.locator("div.fixed.inset-0").filter({ has: page.getByPlaceholder("Type a name…") });
  await expect(form).toBeVisible();
  await form.getByPlaceholder("Type a name…").fill(name);
  const choice = form.getByRole("button", { name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  await expect(choice).toContainText(label);
  if (label !== "Identified") expect(await choice.innerText()).not.toContain("Identified");
  await choice.click();
  await expect(form.getByText(label, { exact: true }).first()).toBeVisible();
  if (label !== "Identified") await expect(form.getByText("Identified", { exact: true })).toHaveCount(0);
}

/* A cashier cannot generate the KYC register. A manager can.
   The sheet is the same component the Reports app prints. */
test("the KYC register reads Missing ID and Expired from the document", async ({ page }) => {
  test.setTimeout(180_000);
  await signInAtDesk(page, "r.haddad");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  const missingName = `Register No Doc ${Date.now().toString(36)}`;
  const expiredName = `Register Expired ${Date.now().toString(36)}`;
  const missingId = await createClient(page, missingName);
  await storeVerified(missingId);
  const expiredId = await createClient(page, expiredName);
  await addPassport(page, expiredId, "2020-01-01");
  await storeVerified(expiredId);

  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  /* The register reads the desk's client list. That list is filled
     when Clients opens, which is what a manager does before printing it. */
  const openedClients = await page.evaluate(() => {
    const button = document.querySelector('[data-app="clients"]');
    if (!button) return "missing";
    (button as HTMLElement).click();
    return "opened";
  });
  expect(openedClients).toBe("opened");
  await expect(page.getByText(missingName).first()).toBeVisible({ timeout: 20_000 });

  const opened = await page.evaluate(() => {
    const button = document.querySelector('[data-app="reports"]');
    if (!button) return "missing";
    (button as HTMLElement).click();
    return "opened";
  });
  expect(opened, "a manager's dock has Reports").toBe("opened");
  await page.getByText("Client & KYC Register", { exact: true }).click();
  const doc = page.locator("#cdos-report-doc");
  await expect(doc).toBeVisible();
  await expect.poll(async () => doc.innerText(), { timeout: 20_000 }).toContain(missingName);
  const sheet = (await doc.innerText()).toUpperCase();
  expect(sheet).toContain("MISSING ID");
  expect(sheet).toContain("EXPIRED");
  const missingAt = sheet.indexOf(missingName.toUpperCase());
  const expiredAt = sheet.indexOf(expiredName.toUpperCase());
  expect(sheet.slice(missingAt, missingAt + 180)).not.toContain("IDENTIFIED");
  expect(sheet.slice(expiredAt, expiredAt + 180)).toContain("EXPIRED");
  expect(sheet.slice(expiredAt, expiredAt + 180)).not.toContain("IDENTIFIED");
});

test("a stored verified passport still reads Identified, and the row stays verified", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Stored Passport ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addPassport(page, clientId, "2030-01-01");
  await storeVerified(clientId);

  const card = await openProfile(page, name);
  await expectChipFilter(page, name, "Identified");
  await card.click();

  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  const standing = profile.getByTestId("client-standing");
  await expect(standing).toContainText("Identified");
  await expect(standing).toContainText("An identity document with a number is on file, and it has not expired.");
  await expect(profile.getByTestId("kyc-stored-standing")).toContainText("Identified");
  expect(await profile.innerText()).not.toMatch(/authenticated/i);

  const stored = await page.evaluate(async (id) => {
    const response = await fetch(`/api/clients/${id}`);
    return { status: response.status, body: await response.json() };
  }, clientId);
  expect(stored.status).toBe(200);
  expect(stored.body.verificationStatus).toBe("verified");
  await expectSameLabelElsewhere(page, name, "Identified");
});

test("a stored verified client with no document reads Missing ID", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Stored No Doc ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await storeVerified(clientId);

  const card = await openProfile(page, name);
  await expectChipFilter(page, name, "Missing ID");
  await card.click();

  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  const standing = profile.getByTestId("client-standing");
  await expect(standing).toContainText("Missing ID");
  await expect(standing).toContainText("No ID on file");
  expect(await standing.innerText()).not.toContain("Identified");
  const kyc = profile.getByTestId("kyc-stored-standing");
  await expect(kyc).toContainText("Missing ID");
  expect(await kyc.innerText()).not.toContain("Identified");

  const stored = await page.evaluate(async (id) => {
    const response = await fetch(`/api/clients/${id}`);
    const body = await response.json();
    const standing = (window as any).CDOS.displayIdStanding({
      verificationStatus: body.verificationStatus,
      idType: "",
      idNum: "",
    }, "2026-10-11");
    return { status: response.status, verificationStatus: body.verificationStatus, label: standing.label };
  }, clientId);
  expect(stored.status).toBe(200);
  expect(stored.verificationStatus).toBe("verified");
  expect(stored.label).toBe("Missing ID");
  await shoot(page, standing, "stored-verified-nodoc");
  await expectSameLabelElsewhere(page, name, "Missing ID");
});

test("an expired ID reads Expired, including when the row is stored verified", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Stored Expired ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addPassport(page, clientId, "2020-01-01");
  await storeVerified(clientId);

  const card = await openProfile(page, name);
  await expectChipFilter(page, name, "Expired");
  await card.click();

  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  const standing = profile.getByTestId("client-standing");
  await expect(standing).toContainText("Expired");
  await expect(standing).toContainText("past its expiry");
  expect(await standing.innerText()).not.toContain("Identified");
  const kyc = profile.getByTestId("kyc-stored-standing");
  await expect(kyc).toContainText("Expired");
  expect(await kyc.innerText()).not.toContain("Identified");

  const stored = await page.evaluate(async (id) => {
    const response = await fetch(`/api/clients/${id}`);
    return { status: response.status, body: await response.json() };
  }, clientId);
  expect(stored.status).toBe(200);
  expect(stored.body.verificationStatus).toBe("verified");
  await shoot(page, standing, "stored-verified-expired");
  await expectSameLabelElsewhere(page, name, "Expired");
});

async function addDocument(page: Page, clientId: string, body: Record<string, unknown>) {
  const documented = await page.evaluate(async ({ id, body }) => {
    const response = await fetch(`/api/clients/${id}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, { id: clientId, body });
  expect(documented.status, JSON.stringify(documented.body)).toBe(201);
}

async function plantDocument(clientId: string, docType: string, docNumber: string) {
  const planted = await pool.query(
    `INSERT INTO desk_client_identity_documents
       (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number, expires_on, is_primary)
     SELECT $1, client_id, tenant_id, legal_entity_id, $3, $4, DATE '2030-01-01', true
       FROM desk_clients WHERE client_id = $2
     RETURNING document_id`,
    [`doc-plant-${clientId}-${docType.length}`, clientId, docType, docNumber],
  );
  expect(planted.rowCount).toBe(1);
}

async function plantNotStated(clientId: string) {
  const planted = await pool.query(
    `INSERT INTO desk_client_identity_documents
       (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number, expires_on, is_primary)
     SELECT $1, client_id, tenant_id, legal_entity_id, 'Not stated', 'NS-1', DATE '2030-01-01', true
       FROM desk_clients WHERE client_id = $2
     RETURNING document_id`,
    [`doc-ns-${clientId}`, clientId],
  );
  expect(planted.rowCount).toBe(1);
}

async function fileShows(page: Page, name: string, label: string, reason: string) {
  const card = await openProfile(page, name);
  await expectChipFilter(page, name, label);
  await card.click();
  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  const standing = profile.getByTestId("client-standing");
  await expect(standing).toContainText(label);
  await expect(standing).toContainText(reason);
  if (label !== "Identified") expect(await standing.innerText()).not.toContain("Identified");
  const kyc = profile.getByTestId("kyc-stored-standing");
  await expect(kyc).toContainText(label);
  await expect(kyc).toContainText(reason);
}

async function openNewDeal(page: Page, name: string) {
  const close = page.getByRole("button", { name: "Close" });
  if (await close.first().isVisible().catch(() => false)) await close.first().click();
  const opened = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return res.ok || res.status === 409 ? "open" : `${res.status}`;
  });
  expect(opened, "the till did not open").toBe("open");
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  /* The menu-bar control opens the sheet. At 390 the word Ledger is
     not a reliable click: the first match can sit in a window title
     the phone layout does not show, and the click waits out the test. */
  const newDeal = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(newDeal).toBeEnabled({ timeout: 30_000 });
  await newDeal.click();
  const form = page.locator("div.fixed.inset-0").filter({ has: page.getByPlaceholder("Type a name…") });
  await expect(form).toBeVisible();
  await form.getByPlaceholder("Type a name…").fill(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const choice = form.getByRole("button", { name: new RegExp("^" + escaped) });
  await expect(choice).toBeVisible({ timeout: 20_000 });
  return { form, choice };
}

async function shootDeal(page: Page, form: ReturnType<Page["locator"]>, stem: string) {
  if (!existsSync("/opt/cursor/artifacts")) return;
  mkdirSync(shots, { recursive: true });
  const phoneRow = form.locator(".cd-tx-id-need");
  await phoneRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/${stem}-390.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(phoneRow).toBeHidden();
  const checklist = form.getByText("Before you post");
  await checklist.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/${stem}-1280.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function fillExchange(page: Page, form: ReturnType<Page["locator"]>, fund: boolean) {
  if (fund) {
    const balances = await ledger(page).till();
    const usd = Number(balances.USD || 0);
    const cad = Number(balances.CAD || 0);
    if (usd < 4000) {
      expect(cad, `till cannot fund 3,500: ${JSON.stringify(balances)}`).toBeGreaterThan(6000);
      await form.getByTitle("Swap").click();
    }
  }
  await form.locator('input[placeholder="0.00"]').first().fill("3500");
  await form.getByPlaceholder(/vacation/).fill("vacation");
  await form.getByPlaceholder(/savings/).fill("savings");
}

/* A 3,500 CAD exchange is over the identification line. The checklist,
   the customer card, and the file have to agree, and a blocked file
   must not reach the quote. */
async function dealGate(page: Page, name: string, label: string, reason: string, post: boolean, stem: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  const { form, choice } = await openNewDeal(page, name);
  await expect(form.locator(".cd-tx")).toBeVisible();
  const head = await form.locator(".cd-tx-head").innerText();
  expect(head).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(head).toMatch(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/);
  await expect(choice).toContainText(label);
  if (label !== "Identified") expect(await choice.innerText()).not.toContain("Identified");
  await choice.click();
  await expect(form.getByText(label, { exact: true }).first()).toBeVisible();
  let quotes = 0;
  let customerBody: Record<string, unknown> | null = null;
  const onRequest = (req: import("@playwright/test").Request) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path === "/api/quotes") quotes += 1;
    if (req.method() === "POST" && path === "/api/ledger/customers") customerBody = req.postDataJSON() as Record<string, unknown>;
  };
  page.on("request", onRequest);
  await fillExchange(page, form, post);
  const phoneRow = form.locator(".cd-tx-id-need");
  await phoneRow.scrollIntoViewIfNeeded();
  await expect(phoneRow).toBeVisible();
  if (!post) {
    await expect(phoneRow).toContainText("ID needed for this amount");
    await expect(phoneRow.locator(".cd-tx-id-need-reason")).toHaveText(reason);
    await expect(form.getByText(reason, { exact: true }).first()).toBeVisible();
    await expect(form.getByText("ID not recorded yet")).toHaveCount(0);
    await expect(form.getByText("READY", { exact: true })).toHaveCount(0);
    await expect(form.getByText("Customer identified")).toHaveCount(0);
    const quote = form.getByRole("button", { name: /to complete|steps? left|Get server quote/ });
    await expect(quote).toBeVisible();
    const quoteLabel = await quote.innerText();
    if (/steps? left/.test(quoteLabel)) await expect(quote).toBeEnabled();
    else await expect(quote).toBeDisabled();
    expect(quoteLabel).not.toMatch(/Get server quote/);
    await expect(form.locator(".cd-tx-id-ok")).toHaveCount(0);
    await shootDeal(page, form, stem);
    expect(quotes).toBe(0);
    expect(customerBody).toBeNull();
    page.off("request", onRequest);
    return;
  }
  await expect(phoneRow).toContainText("on file");
  await expect(phoneRow).not.toContainText("ID needed for this amount");
  if (stem === "id-citizenship-pre-2012" || stem === "id-secure-indian-status") {
    const named = stem === "id-citizenship-pre-2012"
      ? "Canadian citizenship card (pre-2012)"
      : "Secure Certificate of Indian Status";
    const green = form.locator(".cd-tx-id-ok");
    await expect(green).toContainText(named);
    await expect(green).toContainText("on file");
    await expect(green).not.toContainText("2020");
    if (stem === "id-secure-indian-status") await expect(green).toContainText("Jun 1, 2030");
    await expect(form.locator(".cd-tx-id-expired")).toHaveCount(0);
    const idStat = form.locator(".cd-tx-stats > div").filter({ hasText: "ID on file" }).first();
    await expect(idStat).toContainText(named);
    await expect(idStat).not.toContainText("2020");
  }
  await expect(form.getByText("Customer identified")).toBeVisible();
  /* At a phone width the checklist says Ready. A desk width says READY. */
  await expect(form.getByText(/^(READY|Ready)$/).first()).toBeVisible();
  await expect(form.getByText("Missing ID", { exact: true })).toHaveCount(0);
  await expect(form.getByText("Their ID is missing")).toHaveCount(0);
  await shootDeal(page, form, stem);
  const quoted = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/quotes");
  await form.getByRole("button", { name: "Get server quote" }).click();
  expect((await quoted).status()).toBe(201);
  expect(customerBody && customerBody.idStatus).toBe("verified");
  expect(customerBody && "verificationStatus" in customerBody).toBe(false);
  expect(customerBody && "screeningOutcome" in customerBody).toBe(false);
  expect(customerBody && "screeningMatched" in customerBody).toBe(false);
  await form.getByRole("button", { name: "Post frozen quote" }).click();
  try {
    await expect(form).toBeHidden({ timeout: 30_000 });
  } catch (err) {
    throw new Error(`${err}\n${await form.innerText()}`);
  }
  page.off("request", onRequest);
}

test("a Not stated ID is Missing ID on the file and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Not Stated ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await plantNotStated(clientId);
  await fileShows(page, name, "Missing ID", "ID type not stated");
  await dealGate(page, name, "Missing ID", "ID type not stated", false, "id-not-stated");
});

test("an ID with no expiry is Missing ID on the file and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `No Expiry ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, { docType: "Passport", docNumber: "P-NOEXP", source: "staff", isPrimary: true });
  await fileShows(page, name, "Missing ID", "ID has no expiry date");
  await dealGate(page, name, "Missing ID", "ID has no expiry date", false, "id-no-expiry");
});

test("a secondary-only current ID is Missing ID and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Secondary Only ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Passport", docNumber: "P-SEC", source: "staff", isPrimary: false, expiresOn: "2030-01-01",
  });
  await fileShows(page, name, "Missing ID", "A current photo ID is needed");
  await dealGate(page, name, "Missing ID", "A current photo ID is needed", false, "id-secondary-only");
});

test("an expired primary with a current secondary is Missing ID and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Expired Primary ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addPassport(page, clientId, "2020-01-01");
  await addDocument(page, clientId, {
    docType: "Passport", docNumber: "P-SEC-2", source: "staff", isPrimary: false, expiresOn: "2030-01-01",
  });
  await fileShows(page, name, "Missing ID", "Photo ID expired on Jan 1, 2020");
  await dealGate(page, name, "Missing ID", "Photo ID expired on Jan 1, 2020", false, "id-expired-primary-valid-secondary");
});

test("a health card alone is Missing ID and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Health Card ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Health Card", docNumber: "HC-1", source: "staff", isPrimary: true, expiresOn: "2030-01-01",
  });
  await fileShows(page, name, "Missing ID", "Health cards can't be used as ID");
  await dealGate(page, name, "Missing ID", "Health cards can't be used as ID", false, "id-health-card");
});

test("a pre-2012 citizenship card with no expiry is Identified and the 3,500 deal posts", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  await ledger(page).ensureOpeningBalances({ CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" });
  const name = `Citizenship Card ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Canadian citizenship card (pre-2012)", docNumber: "CIT-1", source: "staff", isPrimary: true,
  });
  await fileShows(page, name, "Identified", "An identity document with a number is on file, and it has not expired.");
  await dealGate(page, name, "Identified", "An identity document with a number is on file, and it has not expired.", true, "id-citizenship-pre-2012");
});

test("a PR card with no expiry is Missing ID and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `PR Card ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Permanent Resident Card", docNumber: "PR-1", source: "staff", isPrimary: true,
  });
  await fileShows(page, name, "Missing ID", "ID has no expiry date");
  await dealGate(page, name, "Missing ID", "ID has no expiry date", false, "id-pr-card-no-expiry");
});

test("a generic citizenship card with a future date is Missing ID and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Citizenship Paper ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Citizenship Card", docNumber: "CIT-GEN", source: "staff", isPrimary: true, expiresOn: "2030-01-01",
  });
  await fileShows(page, name, "Missing ID", "A current photo ID is needed");
  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  await expect(profile).toContainText("Citizenship certificate (2012 or later, no photo)");
  expect(await profile.innerText()).not.toContain("Citizenship Card");
  await dealGate(page, name, "Missing ID", "A current photo ID is needed", false, "id-citizenship-card");
});

test("a current Secure Certificate of Indian Status is Identified and the 3,500 deal posts", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  await ledger(page).ensureOpeningBalances({ CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" });
  const name = `Secure Status ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Secure Certificate of Indian Status", docNumber: "CIS-1", source: "staff", isPrimary: true, expiresOn: "2030-06-01",
  });
  await fileShows(page, name, "Identified", "An identity document with a number is on file, and it has not expired.");
  await dealGate(page, name, "Identified", "An identity document with a number is on file, and it has not expired.", true, "id-secure-indian-status");
});

async function optionLabels(select: ReturnType<Page["locator"]>) {
  return select.locator("option").allTextContents();
}

function expectPickerOmitsHealthCard(labels: string[]) {
  const joined = labels.join("\n");
  expect(joined).not.toContain("Health Card");
  expect(joined).not.toContain("Citizenship Card");
  expect(joined).not.toContain("PR Card");
  expect(joined).not.toContain("Driver licence");
  expect(labels).toContain("Passport");
  expect(labels).toContain("Citizenship certificate (2012 or later, no photo)");
}

async function shootBoth(page: Page, stem: string, focus: ReturnType<Page["locator"]>) {
  if (!existsSync("/opt/cursor/artifacts")) return;
  mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await focus.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/${stem}-1280.png` });
  await page.setViewportSize({ width: 360, height: 780 });
  await focus.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/${stem}-360.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await focus.scrollIntoViewIfNeeded();
}

async function shootPr100(page: Page, stem: string, focus: ReturnType<Page["locator"]>) {
  if (!existsSync("/opt/cursor/artifacts")) return;
  mkdirSync(pr100Shots, { recursive: true });
  try {
    for (const [width, height] of [[360, 780], [390, 844], [1280, 800]] as const) {
      await page.setViewportSize({ width, height });
      await focus.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${pr100Shots}/${stem}-${width}.png` });
    }
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
}

async function shootPhone(page: Page, stem: string, focus: ReturnType<Page["locator"]>) {
  const save = existsSync("/opt/cursor/artifacts");
  if (save) mkdirSync(shots, { recursive: true });
  try {
    await page.setViewportSize({ width: 360, height: 780 });
    await focus.scrollIntoViewIfNeeded();
    if (save) await page.screenshot({ path: `${shots}/${stem}-360.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await focus.scrollIntoViewIfNeeded();
    if (save) await page.screenshot({ path: `${shots}/${stem}-390.png` });
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
}

test("pickers omit Health Card and a stored one is read-only", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Stored Health ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Health Card", docNumber: "HC-RO", source: "staff", isPrimary: true, expiresOn: "2030-01-01",
  });
  const card = await openProfile(page, name);
  await card.click();
  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  const row = profile.getByTestId("refused-id-row");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Health Card");
  await expect(row).toContainText("****C-RO");
  await expect(row).not.toContainText("HC-RO");
  await expect(row).toContainText("Health cards can't be used as ID");
  await expect(row.locator("input, select, textarea, button")).toHaveCount(0);
  await expect(profile.getByRole("button", { name: /make primary/i })).toHaveCount(0);
  await expect(profile.getByTestId("client-standing")).toContainText("Health cards can't be used as ID");
  await expect(profile).not.toContainText("HC-RO");

  await profile.getByRole("button", { name: "Edit" }).click();
  const identity = profile.getByTestId("identity-documents");
  const slot = identity.getByTestId("primary-id-slot");
  await expect(slot).toContainText("Primary ID");
  await expect(slot).toContainText("No current photo ID");
  await expect(slot).not.toContainText("Health Card");
  await expect(slot).not.toContainText("HC-RO");
  await expect(slot).not.toContainText("****C-RO");
  await expect(slot.getByTestId("refused-id-row")).toHaveCount(0);
  const aside = identity.getByTestId("not-accepted-id");
  await expect(aside).toContainText("Not accepted as ID");
  const editing = aside.getByTestId("refused-id-row");
  await expect(editing).toBeVisible();
  await expect(editing).toContainText("Health Card");
  await expect(editing).toContainText("****C-RO");
  await expect(editing).not.toContainText("HC-RO");
  await expect(editing).toContainText("Health cards can't be used as ID");
  await expect(editing.locator("input, select, textarea, button")).toHaveCount(0);
  await expect(profile.getByRole("button", { name: /make primary/i })).toHaveCount(0);
  await expect(profile).not.toContainText("HC-RO");
  const typed = await profile.locator("input, textarea").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value).join("\n"));
  expect(typed).not.toContain("HC-RO");
  await shootBoth(page, "health-card-file", identity);
  await profile.getByRole("button", { name: "Add ID" }).click();
  const fileSelects = profile.locator("select").filter({ has: page.locator("option", { hasText: "Passport" }) });
  await expect(fileSelects.first()).toBeVisible();
  expect(await fileSelects.count()).toBeGreaterThan(0);
  for (const select of await fileSelects.all()) expectPickerOmitsHealthCard(await optionLabels(select));
  await shootBoth(page, "id-picker", fileSelects.first());
  await profile.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Add a client. ID scanning isn't connected yet." }).click();
  const addClient = page.locator("div.fixed.inset-0").filter({ hasText: "Add a client" }).last();
  await expect(addClient).toBeVisible();
  expectPickerOmitsHealthCard(await optionLabels(addClient.locator("select").first()));
  await addClient.getByRole("button", { name: "Close" }).click();
  await expect(addClient).toBeHidden();
});

test("a Secure Certificate of Indian Status with no expiry is Missing ID and blocks the 3,500 deal", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const name = `Secure No Expiry ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Secure Certificate of Indian Status", docNumber: "CIS-0", source: "staff", isPrimary: true,
  });
  await fileShows(page, name, "Missing ID", "ID has no expiry date");
  await dealGate(page, name, "Missing ID", "ID has no expiry date", false, "id-secure-indian-status-no-expiry");
});

test("a stored Driver licence alias is the primary photo ID", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  await ledger(page).ensureOpeningBalances({ CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" });
  const name = `Licence Alias ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  await addDocument(page, clientId, {
    docType: "Driver licence", docNumber: "DL-ALIAS-1", source: "staff", isPrimary: true, expiresOn: "2030-06-01",
  });
  const card = await openProfile(page, name);
  await card.click();
  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  await expect(profile.getByTestId("client-standing")).toContainText("Identified");
  await profile.getByRole("button", { name: "Edit" }).click();
  const identity = profile.getByTestId("identity-documents");
  const slot = identity.getByTestId("primary-id-slot");
  await expect(slot).toContainText("Driver's Licence");
  await expect(slot).not.toContainText("No current photo ID");
  await expect(slot.locator("select").first()).toHaveValue("Driver's Licence");
  await expect(slot.locator("input").first()).toHaveValue("DL-ALIAS-1");
  await expect(identity.getByTestId("not-accepted-id")).toHaveCount(0);
  await expect(identity).not.toContainText("Not accepted as ID");
  await shootPhone(page, "driver-licence-alias", identity);
  await profile.getByRole("button", { name: "Close" }).click();
  await dealGate(page, name, "Identified", "An identity document with a number is on file, and it has not expired.", true, "id-driver-licence-alias");
});

test("an OHIP card is a health card and a library card is not accepted", async ({ page }) => {
  test.setTimeout(180_000);
  await openTeller(page);
  const ohipName = `Ohip Alias ${Date.now().toString(36)}`;
  const ohipId = await createClient(page, ohipName);
  const refusedType = await page.evaluate(async (id) => {
    const response = await fetch(`/api/clients/${id}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docType: "OHIP card", docNumber: "OHIP9988", source: "staff", isPrimary: true, expiresOn: "2030-01-01",
      }),
    });
    return { status: response.status, body: await response.text() };
  }, ohipId);
  expect(refusedType.status).toBe(422);
  expect(refusedType.body).toContain("That ID type is not one this desk accepts. Pick a type from the list.");
  expect(refusedType.body).not.toMatch(/Expected|received|String must|Unrecognized key/);
  expect(refusedType.body).not.toContain("docType:");
  await plantDocument(ohipId, "OHIP card", "OHIP9988");
  const ohipCard = await openProfile(page, ohipName);
  await ohipCard.click();
  const ohip = page.locator("div.fixed.inset-0").filter({ hasText: ohipName }).first();
  await expect(ohip.getByTestId("client-standing")).toContainText("Health cards can't be used as ID");
  await ohip.getByRole("button", { name: "Edit" }).click();
  const ohipIdentity = ohip.getByTestId("identity-documents");
  const ohipSlot = ohipIdentity.getByTestId("primary-id-slot");
  await expect(ohipSlot).toContainText("No current photo ID");
  await expect(ohipSlot).not.toContainText("OHIP");
  await expect(ohipSlot).not.toContainText("Health Card");
  const ohipAside = ohipIdentity.getByTestId("not-accepted-id");
  await expect(ohipAside).toContainText("Health Card");
  await expect(ohipAside).toContainText("****9988");
  await expect(ohipAside).not.toContainText("OHI*****");
  await expect(ohipAside).toContainText("Health cards can't be used as ID");
  await expect(ohipAside).not.toContainText("OHIP9988");
  await expect(ohipAside.locator("input, select, textarea")).toHaveCount(0);
  await expect(ohipAside).toContainText("Jan 1, 2030");
  await expect(ohipAside).not.toContainText("2030-01-01");
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(ohipAside).toContainText("Jan 1, 2030");
  await expect(ohipAside).not.toContainText("2030-01-01");
  await shootPhone(page, "ohip-card", ohipIdentity);
  await page.setViewportSize({ width: 1280, height: 800 });
  await ohip.getByRole("button", { name: "Close" }).click();

  const libraryName = `Library Card ${Date.now().toString(36)}`;
  const libraryId = await createClient(page, libraryName);
  const refusedLibrary = await page.evaluate(async (id) => {
    const response = await fetch(`/api/clients/${id}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docType: "Library card", docNumber: "LIB-4455", source: "staff", isPrimary: true, expiresOn: "2030-01-01",
      }),
    });
    return response.status;
  }, libraryId);
  expect(refusedLibrary).toBe(422);
  await plantDocument(libraryId, "Library card", "LIB-4455");
  const libraryCard = await openProfile(page, libraryName);
  await libraryCard.click();
  const library = page.locator("div.fixed.inset-0").filter({ hasText: libraryName }).first();
  await expect(library.getByTestId("client-standing")).toContainText("A current photo ID is needed");
  await expect(library.getByTestId("client-standing")).not.toContainText("Identified");
  await library.getByRole("button", { name: "Edit" }).click();
  const libraryIdentity = library.getByTestId("identity-documents");
  const librarySlot = libraryIdentity.getByTestId("primary-id-slot");
  await expect(librarySlot).toContainText("No current photo ID");
  await expect(librarySlot).not.toContainText("Library card");
  await expect(librarySlot).not.toContainText("LIB-4455");
  const libraryAside = libraryIdentity.getByTestId("not-accepted-id");
  await expect(libraryAside).toContainText("Library card");
  await expect(libraryAside).toContainText("****4455");
  await expect(libraryAside).not.toContainText("LIB-4455");
  await expect(libraryAside).not.toContainText("Health cards can't be used as ID");
  await expect(libraryAside.locator("input, select, textarea")).toHaveCount(0);
  await library.getByRole("button", { name: "Close" }).click();
});

test("a long client name ellipsizes and the postal code stays whole on a phone", async ({ page }) => {
  test.setTimeout(120_000);
  await openTeller(page);
  const name = `Alexandria Montgomery-Worthington of Rosedale ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  const patched = await page.evaluate(async (id) => {
    const response = await fetch(`/api/clients/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: "Toronto", region: "ON", postalCode: "M5V 2T6", addressLine: "100 Bloor Street West" }),
    });
    return { status: response.status, body: await response.json() };
  }, clientId);
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const card = await openProfile(page, name);
  await card.click();
  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  await profile.getByRole("button", { name: "Edit" }).click();
  const postal = profile.getByLabel("Postal code");
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await postal.scrollIntoViewIfNeeded();
    const nameBox = await profile.locator(".client-file-name").evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        textOverflow: style.textOverflow,
        overflowX: style.overflowX,
        whiteSpace: style.whiteSpace,
        scroll: el.scrollWidth,
        client: el.clientWidth,
        right: box.right,
      };
    });
    expect(nameBox.textOverflow, `name ellipsis at ${width}`).toBe("ellipsis");
    expect(nameBox.overflowX, `name clip at ${width}`).toBe("hidden");
    expect(nameBox.whiteSpace, `name nowrap at ${width}`).toBe("nowrap");
    expect(nameBox.scroll, `name wider than its box at ${width}`).toBeGreaterThan(nameBox.client);
    expect(nameBox.right, `name inside the phone at ${width}`).toBeLessThanOrEqual(width + 1);
    const field = await postal.boundingBox();
    expect(field, `postal box at ${width}`).toBeTruthy();
    expect(field!.x, `postal left at ${width}`).toBeGreaterThanOrEqual(0);
    expect(field!.x + field!.width, `postal right at ${width}`).toBeLessThanOrEqual(width + 1);
    expect(field!.width, `postal width at ${width}`).toBeGreaterThan(140);
    const labelCut = await profile.locator("label").filter({ hasText: "Postal code" }).locator("div").first().evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(labelCut, `postal label cut at ${width}`).toBe(false);
    const rule = profile.getByTestId("client-standing-rule");
    await rule.scrollIntoViewIfNeeded();
    const ruleCut = await rule.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(ruleCut, `standing sentence cut at ${width}`).toBe(false);
    const closeBox = await profile.getByRole("button", { name: "Close" }).boundingBox();
    expect(closeBox!.width, `close width at ${width}`).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height, `close height at ${width}`).toBeGreaterThanOrEqual(44);
    const addBox = await profile.getByRole("button", { name: "Add ID" }).boundingBox();
    expect(addBox!.height, `add id height at ${width}`).toBeGreaterThanOrEqual(44);
    const emailBox = await profile.getByLabel("Email").boundingBox();
    expect(emailBox!.height, `email height at ${width}`).toBeGreaterThanOrEqual(44);
    if (existsSync("/opt/cursor/artifacts")) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/long-client-name-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
});

/* #131 leaves docNumber off a health-card read. The key is absent,
   not null. This route does that to the JSON the desk loads, after
   the number has been stored. */
async function withholdHealthCardNumbers(page: Page) {
  const health = (type: string) => isHealthCardType(type);
  const strip = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) strip(item);
      return;
    }
    const row = value as Record<string, unknown>;
    const type = typeof row.docType === "string" ? row.docType
      : typeof row.type === "string" ? row.type
      : "";
    if (type && health(type)) delete row.docNumber;
    for (const child of Object.values(row)) strip(child);
  };
  await page.route("**/api/clients**", async (route) => {
    const response = await route.fetch();
    const contentType = response.headers()["content-type"] || "";
    if (!contentType.includes("json")) {
      await route.fulfill({ response });
      return;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      await route.fulfill({ response });
      return;
    }
    strip(body);
    const headers = { ...response.headers() };
    delete headers["content-encoding"];
    delete headers["content-length"];
    await route.fulfill({
      status: response.status(),
      headers,
      body: JSON.stringify(body),
    });
  });
}

test("a withheld health card number is not the word undefined", async ({ page }) => {
  test.setTimeout(120_000);
  await openTeller(page);
  const name = `Health Withheld ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  const stored = "OHIP7766";
  await plantDocument(clientId, "OHIP card", stored);
  await withholdHealthCardNumbers(page);
  try {
    const card = await openProfile(page, name);
    await card.click();
    const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
    await expect(profile.getByTestId("client-standing")).toContainText("Health cards can't be used as ID");
    const viewRow = profile.getByTestId("refused-id-row");
    await expect(viewRow).toContainText("Number not shown");
    await expect(viewRow).toContainText("Health Card");
    await expect(viewRow).not.toContainText(stored);
    const viewText = await profile.innerText();
    expect(viewText).not.toContain(stored);
    expect(viewText).not.toMatch(/\bundefined\b/);
    expect(viewText).not.toContain("und******");
    expect(viewText).not.toContain("OHI*****");

    await profile.getByRole("button", { name: "Edit" }).click();
    const identity = profile.getByTestId("identity-documents");
    const slot = identity.getByTestId("primary-id-slot");
    await expect(slot).toContainText("No current photo ID");
    await expect(slot).not.toContainText("OHIP");
    await expect(slot).not.toContainText("Health Card");
    const aside = identity.getByTestId("not-accepted-id");
    await expect(aside.getByTestId("refused-id-number")).toHaveText("Number not shown");
    await expect(aside).toContainText("Health Card");
    await expect(aside).toContainText("Health cards can't be used as ID");
    await expect(aside).not.toContainText(stored);
    const asideText = await aside.innerText();
    expect(asideText).not.toMatch(/\bundefined\b/);
    expect(asideText).not.toContain("und******");
    expect(asideText).not.toContain("OHI*****");
    await expect(aside.locator("input, select, textarea")).toHaveCount(0);
  } finally {
    await page.unroute("**/api/clients**");
  }
});

test("a Quebec health card number stays masked at every width", async ({ page }) => {
  test.setTimeout(120_000);
  await openTeller(page);
  const name = `Sam Tremblay ${Date.now().toString(36)}`;
  const clientId = await createClient(page, name);
  const refused = await page.evaluate(async (id) => {
    const response = await fetch(`/api/clients/${id}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docType: "Carte d'assurance maladie",
        docNumber: "TRES12345678",
        source: "staff",
        isPrimary: true,
      }),
    });
    return { status: response.status, body: await response.text() };
  }, clientId);
  expect(refused.status).toBe(422);
  expect(refused.body).toContain("Pick a type from the list.");
  await plantDocument(clientId, "Carte d'assurance maladie", "TRES12345678");
  const card = await openProfile(page, name);
  await card.click();
  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  await expect(profile.getByTestId("client-standing")).toContainText("Health cards can't be used as ID");
  await profile.getByRole("button", { name: "Edit" }).click();
  const aside = profile.getByTestId("not-accepted-id");
  await expect(aside).toContainText("Health Card");
  await expect(aside).toContainText("****5678");
  await expect(aside).not.toContainText("TRES12345678");
  await expect(aside).not.toContainText("TRES");
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : width === 360 ? 780 : 844 });
    const rule = profile.getByTestId("client-standing-rule");
    await rule.scrollIntoViewIfNeeded();
    const cut = await rule.evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth + 1,
      text: el.textContent || "",
    }));
    expect(cut.text.length, `standing copy at ${width}`).toBeGreaterThan(40);
    expect(cut.clipped, `standing sentence cut at ${width}`).toBe(false);
    await expect(aside).toContainText("****5678");
    await expect(aside).not.toContainText("TRES12345678");
    const label = await profile.locator(".client-file-label", { hasText: "Where they are" }).evaluate((el) => {
      const style = getComputedStyle(el);
      return { size: style.fontSize, transform: style.textTransform };
    });
    expect(label.size, `label size at ${width}`).toBe("12px");
    expect(label.transform, `label case at ${width}`).toBe("none");
  }
  const ratio = await profile.getByTestId("standing-pill").evaluate((el) => {
    const channel = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = (rgb: string) => {
      const parts = rgb.match(/\d+/g);
      if (!parts || parts.length < 3) return 0;
      const [r, g, b] = parts.slice(0, 3).map((n) => channel(Number(n)));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(el);
    const hi = Math.max(lum(style.color), lum(style.backgroundColor));
    const lo = Math.min(lum(style.color), lum(style.backgroundColor));
    return (hi + 0.05) / (lo + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await shootPr100(page, "quebec-health-card", profile);
  await page.setViewportSize({ width: 1280, height: 800 });
  await profile.getByRole("button", { name: "Close" }).click();
});

test("the ledger new-customer picker lists the current person types", async ({ page }) => {
  test.setTimeout(120_000);
  await openTeller(page);
  const opened = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return res.ok || res.status === 409 ? "open" : `${res.status}`;
  });
  expect(opened, "the till did not open").toBe("open");
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await page.getByText(/^Ledger$/).first().click();
  const newDeal = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(newDeal).toBeEnabled({ timeout: 30_000 });
  await newDeal.click();
  const form = page.locator(".cd-tx");
  await expect(form.getByPlaceholder("Type a name…")).toBeVisible();
  await form.getByPlaceholder("Type a name…").fill("Picker Check");
  const add = form.getByRole("button", { name: /Add a client and record their ID|Add new client/ });
  await expect(add).toBeVisible({ timeout: 15_000 });
  await add.click();
  const flow = page.locator("div.fixed.inset-0").filter({ hasText: "Type the name and the ID from the document" });
  await expect(flow).toBeVisible();
  const person = await optionLabels(flow.locator("select").first());
  expect(person).toEqual([
    "Choose…",
    "Passport",
    "Driver's Licence",
    "Driver's License",
    "Provincial ID",
    "Permanent Resident Card",
    "Citizenship certificate (2012 or later, no photo)",
    "Canadian citizenship card (pre-2012)",
    "Secure Certificate of Indian Status",
    "Birth certificate",
  ]);
  expectPickerOmitsHealthCard(person);
  await flow.getByRole("button", { name: "Business", exact: true }).click();
  const business = await optionLabels(flow.locator("select").first());
  expect(business).toEqual([
    "Choose…",
    "Business Number",
    "Incorporation Certificate",
    "Master Business Licence",
    "Articles of Incorporation",
  ]);
  expect(business).not.toContain("Health Card");
});
