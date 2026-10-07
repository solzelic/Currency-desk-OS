/* A new European Union desk, on the screen.
   The 2027 disclaimer is the sentence the owner has to see, and the
   opt-in is the only way an older EU desk reaches that pack. */
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect, hasLedger, landOnDesktop, rendered, codeFor, logSize } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@eu-amlr-seam.example`;
const SHOP = `EU AMLR Seam ${stamp}`;
const SLUG = `euseam${stamp}`;

let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (!pool) return;
  await pool.end();
});

async function openCompliance(page: Page) {
  await page.getByText(/^Settings$/i).first().click();
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();
  await rendered(page, /Compliance & jurisdiction/i);
}

test("a new EU desk shows the 2027 rules and not a 10,000 cash report", async ({ page }) => {
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-${stamp}`, `CD-E${String(stamp).slice(-6)}`, EMAIL, "EU Owner"],
  );
  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "EU Owner",
      email: EMAIL,
      password: "eu-amlr-desk-2026",
      slug: SLUG,
      onboarding: { country: "European Union", homeCurrency: "EUR", city: "Paris", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);

  const pack = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version, home_currency
       FROM legal_entities WHERE id = $1`,
    [`le-${SLUG}`],
  );
  expect(pack.rows[0]?.jurisdiction_pack_id).toBe("pack-eu-v2");
  expect(Number(pack.rows[0]?.jurisdiction_pack_version)).toBe(2);
  expect(String(pack.rows[0]?.home_currency).trim()).toBe("EUR");

  await page.goto("/app");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await expect(page.getByText(/They apply from 10 July 2027/).first()).toBeVisible();

  await openCompliance(page);
  const panel = page.getByTestId("compliance-jurisdiction");
  await expect(panel.locator("[data-rules-notice]")).toContainText("10 July 2027");
  await expect(panel.getByTestId("eu-amlr-lines")).toContainText("Cash identification at or above 3000.00 EUR");
  await expect(panel.getByTestId("eu-amlr-lines")).toContainText("Full customer due diligence at or above 10000.00 EUR");
  await expect(panel.getByTestId("eu-amlr-lines")).toContainText("Transfer customer due diligence at or above 1000.00 EUR");
  await expect(panel.getByTestId("eu-no-large-cash")).toHaveText("Not required");
  await expect(panel.getByTestId("eu-no-aggregation")).toHaveText("Not stated");
  const words = await panel.innerText();
  expect(words).not.toMatch(/\bAMLD\b/);
  expect(words).not.toMatch(/Harmonised/);

  const ruling = await page.evaluate(() => {
    const rule = window.CDOS._transfers.transferRuling;
    const lines = [
      { lineId: "cash_identify", dealKind: "any", threshold: "3000.00", comparator: "gte", cashOnly: true },
      { lineId: "occasional_cdd", dealKind: "any", threshold: "10000.00", comparator: "gte", cashOnly: false },
      { lineId: "transfer_cdd", dealKind: "remittance", threshold: "1000.00", comparator: "gte", cashOnly: false },
    ];
    return {
      under: rule({ direction: "send", principal: "999.99", fee: "0", euLines: lines, deskLine: null }),
      at: rule({ direction: "send", principal: "1000.00", fee: "0", euLines: lines, deskLine: null }),
      looserCash: rule({ direction: "send", principal: "2000.00", fee: "0", euLines: lines, deskLine: "5000.00" }),
    };
  });
  expect(ruling.under).toMatchObject({ reportable: false, idRequired: false });
  expect(ruling.at).toMatchObject({ reportable: false, idRequired: true });
  expect(ruling.looserCash).toMatchObject({ reportable: false, idRequired: true });

  /* Same signed-in desk. A later test would open a fresh browser and
     would not still be this owner. */
  await pool.query(
    `UPDATE legal_entities
        SET jurisdiction_pack_id = 'pack-eu-v1', jurisdiction_pack_version = 1
      WHERE id = $1`,
    [`le-${SLUG}`],
  );
  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await openCompliance(page);
  await page.getByTestId("eu-amlr-opt-in").click();
  await expect(page.getByTestId("eu-amlr-lines")).toContainText("Cash identification at or above 3000.00 EUR");
  await expect(page.getByText(/They apply from 10 July 2027/).first()).toBeVisible();
  const moved = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version FROM legal_entities WHERE id = $1`,
    [`le-${SLUG}`],
  );
  expect(moved.rows[0]?.jurisdiction_pack_id).toBe("pack-eu-v2");
  expect(Number(moved.rows[0]?.jurisdiction_pack_version)).toBe(2);
});
