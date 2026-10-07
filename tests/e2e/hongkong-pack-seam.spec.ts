/* A new Hong Kong desk, read off Settings.

   The ledger opens it on pack-hk-v1. This checks the screen says so,
   and that it does not call a cash report, a 24 hour window, or a
   sample sanctions queue into being. Signup is invite-only, so the
   enquiry is invited first, the same way the baseline seam does it.
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
const EMAIL = `owner-${stamp}@hongkong-seam.example`;
const SHOP = `Hong Kong Seam ${stamp}`;
const SLUG = `hkseam${stamp}`;

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

test("a Hong Kong desk shows the Hong Kong pack and no cash report", async ({ page }) => {
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-${stamp}`, `CD-H${String(stamp).slice(-6)}`, EMAIL, "Hong Kong Owner"],
  );
  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "Hong Kong Owner",
      email: EMAIL,
      password: "hongkong-desk-2026",
      slug: SLUG,
      onboarding: { country: "HK", homeCurrency: "HKD", city: "Hong Kong", plan: "full" },
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
  await expect(packCard.getByText("C&ED / JFIU")).toBeVisible();
  await expect(packCard.getByText("Hong Kong", { exact: true })).toBeVisible();
  await expect(packCard.getByText("Suspicious Transaction Report")).toBeVisible();
  await expect(panel.getByText("Cash transaction report", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("hongkong-screening-gap")).toBeVisible();
  await expect(panel.getByText("Aggregation window")).toHaveCount(0);
  await expect(panel.getByText("OFAC")).toHaveCount(0);

  const words = await panel.innerText();
  expect(words).not.toMatch(/International baseline/);
  expect(words).not.toMatch(/24-hour window/);
  expect(words).toMatch(/no cash transaction report/i);
  expect(words).toMatch(/does not file/i);
  expect(words).toMatch(/No sanctions list is loaded/i);
  expect(words).toMatch(/United Nations Sanctions Ordinance/);
  expect(words).not.toMatch(/\bLive\b/);

  /* Shared settings chrome still uses dashes. The sentences this pack
     wrote do not. Check those sentences, not the whole panel. */
  const owned = [
    "There is no cash transaction report for a money service operator. 120000 HKD is customer due diligence for money changing, not a cash report. A traveller carrying more than 120000 HKD declares it to Customs. That is not this desk.",
    "Money changing is at or above this figure. A wire transfer, a remittance, and a virtual asset transfer are at or above 8000 HKD, and a higher desk line does not lift that. A bill, a money order, and a cheque use the money-changing line. Linked deals are not summed.",
    "Your jurisdiction follows the operating country set in Localization. Money changing at or above 120000 HKD needs customer due diligence. Exactly 120000 does. A wire transfer, a remittance, and a virtual asset transfer need it at or above 8000 HKD. Exactly 8000 does. There is no cash transaction report. A suspicious transaction report goes to the JFIU. This desk does not file it.",
    "No sanctions list is loaded. Hong Kong law requires the owner to screen against designated persons under the United Nations Sanctions Ordinance (Cap. 537) and the United Nations (Anti-Terrorism Measures) Ordinance (Cap. 575). The owner does this outside the desk. This screen does not match names.",
    "Money changing at or above 120000 HKD needs customer due diligence. A wire, a remittance, and a virtual asset transfer need it at or above 8000 HKD. There is no cash report. This desk does not file to the JFIU and does not screen a sanctions list.",
  ];
  for (const sentence of owned) {
    expect(words).toContain(sentence);
    expect(sentence).not.toMatch(/\u2014/);
    expect(sentence).not.toMatch(/\u2013/);
  }

  /* The compliance desk tags the suspicious-transaction duty Listed,
     the same word as the pack and the website. The large-cash pack
     must not tell this desk to verify a filing in a portal. */
  await page.getByText("Compliance", { exact: true }).first().click();
  await rendered(page, /No cash report/i);
  const desk = page.locator("body");
  await expect(desk.getByText("Listed", { exact: true }).first()).toBeVisible();
  await expect(desk.getByText("STR", { exact: true }).first()).toBeVisible();
  await page.getByText("Reports", { exact: true }).first().click();
  /* The launcher names this card from the pack, not from the Canadian title. */
  await page.getByText(/Suspicious Transaction Report Pack/).first().click();
  await rendered(page, /does not file it/i);
  const packText = await page.locator("body").innerText();
  expect(packText).toMatch(/does not file it/i);
  expect(packText).not.toMatch(/verify each filing/i);
});
