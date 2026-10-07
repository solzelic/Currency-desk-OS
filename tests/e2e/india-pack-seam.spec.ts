/* A new India desk, read off Settings.

   The ledger opens it on pack-in-v1. This checks the screen says so,
   and that it does not call the cash rule a 24-hour window.
   Signup is invite-only, so the enquiry is invited first, the same
   way the baseline seam does it.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, rendered, codeFor, logSize } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@india-seam.example`;
const SHOP = `India Seam ${stamp}`;
const SLUG = `iseam${stamp}`;

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
  await rendered(page, /Reporting & thresholds/i);
}

test("an India desk shows the India pack and a calendar month, not a 24-hour window", async ({ page }) => {
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-${stamp}`, `CD-I${String(stamp).slice(-6)}`, EMAIL, "India Owner"],
  );
  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "India Owner",
      email: EMAIL,
      password: "india-desk-2026",
      slug: SLUG,
      onboarding: { country: "IN", homeCurrency: "INR", city: "Mumbai", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);

  await page.goto("/app");
  await landOnDesktop(page);
  await expect(page.getByText(SHOP).first()).toBeVisible();
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  await openComplianceSettings(page);
  const panel = page.getByTestId("compliance-jurisdiction");
  const packCard = panel.getByTestId("country-pack");
  await expect(packCard).toBeVisible();
  await expect(panel.getByTestId("baseline-pack")).toHaveCount(0);
  await expect(packCard.getByText("RBI / FIU-IND")).toBeVisible();
  await expect(packCard.getByText("India", { exact: true })).toBeVisible();
  await expect(packCard.getByText("Currency Transaction Report")).toBeVisible();
  await expect(panel.getByText("Cash report window")).toBeVisible();
  await expect(panel.getByText(/calendar month in India/i).first()).toBeVisible();
  await expect(panel.getByText("Aggregation window")).toHaveCount(0);

  const words = await panel.innerText();
  expect(words).not.toMatch(/International baseline/);
  expect(words).not.toMatch(/24-hour window/);
});
