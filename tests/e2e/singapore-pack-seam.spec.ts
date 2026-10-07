/* A new Singapore desk, read off Settings.

   The ledger opens it on pack-sg-v1. This checks the screen says so,
   and that it does not call a cash report or a 24 hour window into
   being. Signup is invite-only, so the enquiry is invited first, the
   same way the baseline seam does it.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, rendered, codeFor, logSize } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger.");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@singapore-seam.example`;
const SHOP = `Singapore Seam ${stamp}`;
const SLUG = `sgseam${stamp}`;

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

test("a Singapore desk shows the Singapore pack and no cash report", async ({ page }) => {
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-${stamp}`, `CD-S${String(stamp).slice(-6)}`, EMAIL, "Singapore Owner"],
  );
  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "Singapore Owner",
      email: EMAIL,
      password: "singapore-desk-2026",
      slug: SLUG,
      onboarding: { country: "SG", homeCurrency: "SGD", city: "Singapore", plan: "full" },
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
  await expect(packCard.getByText("MAS / STRO")).toBeVisible();
  await expect(packCard.getByText("Singapore", { exact: true })).toBeVisible();
  await expect(packCard.getByText("Suspicious Transaction Report")).toBeVisible();
  await expect(panel.getByText("Cash transaction report", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("singapore-screening-gap")).toBeVisible();
  await expect(panel.getByText("Aggregation window")).toHaveCount(0);

  const words = await panel.innerText();
  expect(words).not.toMatch(/International baseline/);
  expect(words).not.toMatch(/24-hour window/);
  expect(words).toMatch(/no cash transaction report/i);
  expect(words).toMatch(/does not file/i);
  expect(words).toMatch(/No sanctions list ships/i);
  expect(words).not.toMatch(/\bLive\b/);
});
