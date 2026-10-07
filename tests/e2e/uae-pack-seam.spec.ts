/* ============================================================
   A United Arab Emirates desk, on the screen and in the book.

   A new signup opens on pack-ae-v2. An older desk is moved back
   to pack-ae-v1 in the database, the way a desk that signed up
   before this pack existed still sits, and the owner opts in
   from Settings. The deal posted before that click keeps the
   v1 stamp. A money transfer of AED 1.00 after the click does
   not post without purpose and source of funds.

   The public pages are the same claim the till makes: there is
   no cash threshold report at AED 55,000.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, rendered, codeFor, logSize } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: { jurisdiction_pack_id: string; jurisdiction_pack_version: number }[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@uae-pack-seam.example`;
const SHOP = `UAE Seam ${stamp}`;
const SLUG = `aeseam${stamp}`;
const ENTITY = `le-${SLUG}`;

let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (!pool) return;
  await pool.end();
});

async function openComplianceSettings(page: Page) {
  await page.getByText(/^Settings$/i).first().click();
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();
  await rendered(page, /Compliance & jurisdiction/i);
}

function remit(key: string, customerId: string, amount: string, purpose: string, source: string) {
  return {
    idempotencyKey: key,
    customerId,
    reference: key,
    principalAmount: amount,
    feeAmount: "0.00",
    payoutCurrency: "USD",
    payoutAmount: "1.00",
    corridor: "US",
    partner: "UAE Seam Partner",
    beneficiaryName: "A Beneficiary",
    purpose,
    sourceOfFunds: source,
  };
}

test("a new UAE desk opens on pack-ae-v2, an older desk opts in, and the site does not call 55,000 a cash report", async ({ page }) => {
  test.setTimeout(180_000);

  const compliance = await page.request.get("/compliance");
  expect(compliance.status()).toBe(200);
  const complianceHtml = await compliance.text();
  expect(complianceHtml).not.toContain("Cash threshold AED 55,000");
  expect(complianceHtml).not.toContain("Deals at or above AED 55,000");
  expect(complianceHtml).toContain("AED 3,500 or more on one deal. No cash threshold report.");

  const home = await page.request.get("/");
  expect(home.status()).toBe(200);
  const homeHtml = await home.text();
  expect(homeHtml).not.toContain("Cash threshold AED 55,000");
  expect(homeHtml).toContain("AED 3,500 or more");

  const phone = await page.request.get("/", {
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
  });
  expect(phone.status()).toBe(200);
  const phoneHtml = await phone.text();
  expect(phoneHtml).not.toContain("Threshold AED 55,000");
  expect(phoneHtml).toContain("AED 3,500");

  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-ae${stamp}`, `CD-A${String(stamp).slice(-6)}`, EMAIL, "UAE Owner"],
  );

  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "UAE Owner",
      email: EMAIL,
      password: "uae-desk-2026",
      slug: SLUG,
      onboarding: { country: "AE", homeCurrency: "AED", city: "Dubai", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);

  await page.goto("/app");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  await expect.poll(async () => {
    const answer = await page.evaluate(() =>
      fetch("/api/ledger/jurisdiction").then(async (r) => ({ status: r.status, body: await r.json() })),
    );
    return answer.status === 200 ? answer.body.pack && answer.body.pack.packId : "";
  }, { timeout: 20_000 }).toBe("pack-ae-v2");

  await pool.query(
    `UPDATE legal_entities
        SET jurisdiction_pack_id = 'pack-ae-v1', jurisdiction_pack_version = 1
      WHERE id = $1`,
    [ENTITY],
  );
  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  await openComplianceSettings(page);
  await expect(page.getByTestId("adopt-ae-pack")).toBeVisible();

  const opened = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return res.ok || res.status === 409 ? "open" : `${res.status} ${await res.text()}`;
  });
  expect(opened, "the till did not open").toBe("open");

  const funded = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/opening-balances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balances: { AED: "5000.00" } }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(201);

  const made = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalRef: "ae-seam-walker",
        name: "Unidentified Walker",
        risk: "normal",
        idStatus: "missing",
      }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const customerId = made.body.customerId as string;

  const posted = await page.evaluate(async (body) => {
    const res = await fetch("/api/ledger/remittances/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, remit(`ae-v1-${stamp}`, customerId, "100.00", "Family support", "Salary"));
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);

  const stampRow = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version
       FROM ledger_transactions WHERE transaction_id = $1`,
    [posted.body.transactionId],
  );
  expect(stampRow.rows[0]).toMatchObject({
    jurisdiction_pack_id: "pack-ae-v1",
    jurisdiction_pack_version: 1,
  });

  await page.getByTestId("adopt-ae-pack").click();
  const card = page.getByTestId("ae-pack-v2");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const words = await card.innerText();
  expect(words).toContain("There is no cash threshold report");
  expect(words).toContain("AED 3,500");
  expect(words).toContain("any amount");
  await expect(page.getByTestId("adopt-ae-pack")).toHaveCount(0);
  await expect(page.getByTestId("ae-pack-rules")).toContainText("There is no cash report at AED 55,000");
  await expect(page.getByTestId("ae-pack-rules")).toContainText("90 day totals");

  const kept = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version
       FROM ledger_transactions WHERE transaction_id = $1`,
    [posted.body.transactionId],
  );
  expect(kept.rows).toEqual(stampRow.rows);

  const lines = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/desk-thresholds");
    return { status: res.status, body: await res.json() };
  });
  expect(lines.status, JSON.stringify(lines.body)).toBe(200);
  expect(lines.body.packId).toBe("pack-ae-v2");
  expect(lines.body.reportThreshold.effective).toBeNull();
  expect(lines.body.idThreshold.effective).toBe("3500.00");
  expect(lines.body.transferDueDiligence).toMatchObject({ everyDeal: true, amount: null });

  const bare = await page.evaluate(async (body) => {
    const res = await fetch("/api/ledger/remittances/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, remit(`ae-bare-${stamp}`, customerId, "1.00", "", ""));
  expect(bare.status, JSON.stringify(bare.body)).toBe(422);
  expect(bare.body.code).toBe("COMPLIANCE_BLOCKED");

  const verifiedCustomer = await page.evaluate(async (id) => {
    const res = await fetch(`/api/ledger/customers/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Known Walker", risk: "normal", idStatus: "verified" }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, customerId);
  expect(verifiedCustomer.status, JSON.stringify(verifiedCustomer.body)).toBe(200);

  const noPurpose = await page.evaluate(async (body) => {
    const res = await fetch("/api/ledger/remittances/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, remit(`ae-nopurpose-${stamp}`, customerId, "1.00", "", ""));
  expect(noPurpose.status, JSON.stringify(noPurpose.body)).toBe(422);
  expect(noPurpose.body.code).toBe("COMPLIANCE_BLOCKED");

  const withPurpose = await page.evaluate(async (body) => {
    const res = await fetch("/api/ledger/remittances/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, remit(`ae-v2-${stamp}`, customerId, "1.00", "Family support", "Salary"));
  expect(withPurpose.status, JSON.stringify(withPurpose.body)).toBe(201);
  const v2Stamp = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version
       FROM ledger_transactions WHERE transaction_id = $1`,
    [withPurpose.body.transactionId],
  );
  expect(v2Stamp.rows[0]).toMatchObject({
    jurisdiction_pack_id: "pack-ae-v2",
    jurisdiction_pack_version: 2,
  });

  const ruling = await page.evaluate(() => {
    const rule = window.CDOS._transfers.transferRuling;
    return {
      ae: rule({
        direction: "send",
        principal: "1.00",
        fee: "0.00",
        baseline: false,
        remittanceLine: null,
        deskLine: null,
        idLine: "3500.00",
        reportLine: null,
        aeTransfer: { amount: null, comparator: "gte", everyDeal: true },
      }),
      canada: rule({
        direction: "send",
        principal: "100.00",
        fee: "0.00",
        baseline: false,
        idLine: "3000.00",
        reportLine: "10000.00",
      }),
    };
  });
  expect(ruling.ae).toMatchObject({ homeAmount: "1.00", idRequired: true });
  expect(ruling.canada).toMatchObject({ homeAmount: "100.00", idRequired: false });

  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await expect.poll(() => page.evaluate(() => {
    const t = window.CDOS.deskThresholds && window.CDOS.deskThresholds();
    return !!(t && t.transferDueDiligence && t.transferDueDiligence.everyDeal);
  }), { timeout: 20_000 }).toBe(true);
  await page.getByText(/^Transfers$/).first().click();
  const newTransfer = page.getByRole("button", { name: /New transfer/i }).first();
  await expect(newTransfer).toBeVisible({ timeout: 30_000 });
  await newTransfer.click();
  const form = page.locator("div.fixed.inset-0").filter({ has: page.getByRole("button", { name: /Create transfer/i }) });
  await expect(form.getByText("Customer pays in (AED)")).toBeVisible();
  await form.getByPlaceholder("0.00").first().fill("1.00");
  await expect(form.getByText(/ID required/i)).toBeVisible();
});
