/* ============================================================
   A United Kingdom desk, on the screen and then on the ledger.

   A new GB desk opens on pack-gb-v2. A desk that is still on
   pack-gb-v1 sees a button and moves itself. A remittance posted
   before that move keeps the v1 stamp. After the move, £800.00
   posts and £800.01 does not: a transfer of funds of more than
   £800 needs customer due diligence, and £800.00 does not exceed it.

   The compliance card has to say there is no large-cash report.
   A server test that only reads the pack row cannot catch a screen
   that still calls 10,000 a cash report.
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
    query: (sql: string, params?: unknown[]) => Promise<{
      rows: { jurisdiction_pack_id: string; jurisdiction_pack_version: number; input_amount: string }[];
    }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@uk-pack-seam.example`;
const SHOP = `UK Pack ${stamp}`;
const SLUG = `ukseam${stamp}`;
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

async function openComplianceSettings(page: Page, heading: RegExp) {
  await page.getByText(/^Settings$/i).first().click();
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();
  await rendered(page, heading);
}

async function skipTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
}

test("a new GB desk opens on pack-gb-v2, an older desk opts in, and the transfer line is more than £800", async ({ page }) => {
  test.setTimeout(180_000);
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-uk${stamp}`, `CD-U${String(stamp).slice(-6)}`, EMAIL, "UK Owner"],
  );

  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "UK Owner",
      email: EMAIL,
      password: "uk-pack-seam-2026",
      slug: SLUG,
      onboarding: { country: "GB", homeCurrency: "GBP", city: "London", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);

  await page.goto("/app");
  await landOnDesktop(page);
  await skipTour(page);

  await expect.poll(async () => {
    const body = await page.evaluate(() => fetch("/api/ledger/jurisdiction").then((r) => r.json()));
    return body.pack && body.pack.packId;
  }, { timeout: 20_000 }).toBe("pack-gb-v2");

  /* Put this desk back on the published pack, the way a desk that
     opened before v2 still is. The signup itself proved the new path. */
  await pool.query(
    `UPDATE legal_entities
        SET jurisdiction_pack_id='pack-gb-v1', jurisdiction_pack_version=1
      WHERE id=$1`,
    [ENTITY],
  );
  await page.reload();
  await landOnDesktop(page);
  await skipTour(page);

  await openComplianceSettings(page, /Large cash \/ reportable threshold/i);
  const adopt = page.getByTestId("adopt-uk-pack");
  await expect(adopt).toBeVisible();

  const ready = await page.evaluate(async () => {
    const notes: string[] = [];
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status !== "open") {
      const opened = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      notes.push(opened.ok || opened.status === 409 ? "session:open" : `session:${opened.status} ${await opened.text()}`);
    } else {
      notes.push("session:open");
    }
    const made = await fetch("/api/ledger/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalRef: `uk-seam-${Date.now()}`,
        name: "UK Seam Walk-in",
        risk: "normal",
        idStatus: "missing",
      }),
    });
    const customer = await made.json().catch(() => ({}));
    notes.push(made.status === 201 && customer.customerId ? `customer:${customer.customerId}` : `customer:${made.status}`);
    return { notes, customerId: customer.customerId as string | undefined };
  });
  expect(ready.notes.filter((n) => !/^(session:open|customer:.+)$/.test(n)), ready.notes.join(" · ")).toEqual([]);
  const customerId = ready.customerId!;

  const send = (principal: string, key: string) =>
    page.evaluate(async ([id, amount, idempotencyKey]) => {
      const res = await fetch("/api/ledger/remittances/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          customerId: id,
          reference: idempotencyKey,
          principalAmount: amount,
          feeAmount: "0.00",
          payoutCurrency: "USD",
          payoutAmount: "1.00",
          corridor: "US",
          partner: "UK Seam Partner",
          beneficiaryName: "A Beneficiary",
          purpose: "",
          sourceOfFunds: "",
        }),
      });
      return { status: res.status, body: await res.text() };
    }, [customerId, principal, key] as const);

  const under = await send("500.00", `uk-v1-${stamp}`);
  expect(under.status, under.body).toBe(201);
  const stamped = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version, input_amount::text
       FROM ledger_transactions
      WHERE legal_entity_id=$1
      ORDER BY posted_at`,
    [ENTITY],
  );
  expect(stamped.rows).toEqual([
    { jurisdiction_pack_id: "pack-gb-v1", jurisdiction_pack_version: 1, input_amount: "500.00" },
  ]);

  await adopt.click();
  await expect.poll(async () => {
    const body = await page.evaluate(() => fetch("/api/ledger/jurisdiction").then((r) => r.json()));
    return body.pack && body.pack.packId;
  }, { timeout: 20_000 }).toBe("pack-gb-v2");

  const still = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version
       FROM ledger_transactions
      WHERE legal_entity_id=$1 AND input_amount=500`,
    [ENTITY],
  );
  expect(still.rows).toEqual([
    { jurisdiction_pack_id: "pack-gb-v1", jurisdiction_pack_version: 1 },
  ]);

  const panel = page.getByTestId("compliance-jurisdiction");
  await expect(panel.getByTestId("uk-pack-v2")).toBeVisible();
  await expect(panel.getByText("No large-cash report. UK law does not require one for a bureau.")).toBeVisible();
  await expect(panel.getByText(/£12,000 or more/)).toBeVisible();
  await expect(panel.getByText(/more than £800/)).toBeVisible();
  await expect(panel.getByText(/NCA \(UKFIU\)/)).toBeVisible();
  await expect(page.getByTestId("adopt-uk-pack")).toHaveCount(0);
  await expect(page.getByTestId("uk-pack-rules")).toBeVisible();

  const atLine = await send("800.00", `uk-v2-at-${stamp}`);
  expect(atLine.status, atLine.body).toBe(201);
  const over = await send("800.01", `uk-v2-over-${stamp}`);
  expect(over.status, over.body).toBe(422);
  expect(over.body).toContain("COMPLIANCE_BLOCKED");

  const after = await pool.query(
    `SELECT jurisdiction_pack_id, input_amount::text AS input_amount
       FROM ledger_transactions
      WHERE legal_entity_id=$1
      ORDER BY posted_at`,
    [ENTITY],
  );
  expect(after.rows).toEqual([
    { jurisdiction_pack_id: "pack-gb-v1", input_amount: "500.00" },
    { jurisdiction_pack_id: "pack-gb-v2", input_amount: "800.00" },
  ]);
});
