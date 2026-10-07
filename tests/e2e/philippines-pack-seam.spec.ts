/* A new Philippines desk, read off Settings.

   The ledger opens it on pack-ph-v1. This checks the screen says so,
   and that it does not call the cash rule a 24-hour window.
   Signup is invite-only, so the enquiry is invited first, the same
   way the baseline seam does it.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, rendered, codeFor, logSize } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@philippines-seam.example`;
const SHOP = `Philippines Seam ${stamp}`;
const SLUG = `pseam${stamp}`;

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

test("a Philippines desk shows the Philippines pack and a banking day, not a 24-hour window", async ({ page }) => {
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-${stamp}`, `CD-P${String(stamp).slice(-6)}`, EMAIL, "Philippines Owner"],
  );
  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "Philippines Owner",
      email: EMAIL,
      password: "philippines-desk-2026",
      slug: SLUG,
      onboarding: { country: "PH", homeCurrency: "PHP", city: "Manila", plan: "full" },
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
  await expect(packCard.getByText("BSP / AMLC")).toBeVisible();
  await expect(packCard.getByText("Philippines", { exact: true })).toBeVisible();
  await expect(packCard.getByText("Covered Transaction Report")).toBeVisible();
  await expect(panel.getByText("Cash report window")).toBeVisible();
  await expect(panel.getByText(/not summed/i).first()).toBeVisible();
  await expect(panel.getByText("Aggregation window")).toHaveCount(0);

  const words = await panel.innerText();
  expect(words).not.toMatch(/International baseline/);
  expect(words).not.toMatch(/24-hour window/);
  expect(words).toMatch(/does not file to the AMLC/i);
  expect(words).toMatch(/not summed/i);

  /* No list is loaded. The copy still states the screening duty. */
  expect(words).toMatch(/No sanctions list is loaded/);
  expect(words).toMatch(/UNSC Consolidated List/);
  expect(words).toMatch(/ATC list/);
  expect(words).toMatch(/freeze without delay/);
  expect(words).toMatch(/tell the AMLC the same day/);
  expect(words).toMatch(/file an STR/);
  expect(words).toMatch(/outside the desk/);
  expect(words).toMatch(/Not on this desk/);
  expect(words).not.toMatch(/OFAC/);
  expect(words).not.toMatch(/OSFI/);

  await page.locator('[data-app="compliance"]').click();
  const screening = page.getByTestId("philippines-screening");
  await expect(screening).toBeVisible();
  const screeningWords = await screening.innerText();
  expect(screeningWords).toMatch(/No sanctions list is loaded/);
  expect(screeningWords).toMatch(/UNSC Consolidated List/);
  expect(screeningWords).toMatch(/ATC list/);
  expect(screeningWords).toMatch(/freeze without delay/);
  expect(screeningWords).toMatch(/tell the AMLC the same day/);
  expect(screeningWords).toMatch(/file an STR/);
  expect(screeningWords).toMatch(/outside the desk/);
  await expect(page.getByText(/Every client and beneficiary screened against OFAC/i)).toHaveCount(0);

  const tile = page.getByTestId("philippines-screening-tile");
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("0");
  await expect(tile).toContainText("No list loaded");

  await page.locator("button.fld-tab").filter({ hasText: /Not filed/ }).click();
  await expect(page.getByText("The desk does not file. The owner files in the AMLC portal. A single deal over the line is flagged. Deals in one banking day are not summed.")).toBeVisible();
});
