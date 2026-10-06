/* ============================================================
   A baseline desk's Settings, read off the screen.

   The ledger was already converting 10,000 USD and 3,000 USD into the
   desk's currency. The compliance tab was still painting Canada: the
   browser's own fallback, FINTRAC, and those two dollar figures labelled
   as if they were dinars. This walks a real signup onto pack-intl-v1
   and reads the tab. A Canada desk is covered by desk-thresholds-seam,
   which still expects FINTRAC.
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
    query: (sql: string, params?: unknown[]) => Promise<{ rows: { id: string; fetched_at: Date }[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@baseline-seam.example`;
const SHOP = `Baseline Seam ${stamp}`;
const SLUG = `bseam${stamp}`;
const SNAP = `snap-baseline-settings-${stamp}`;
/* USD 1.36 and GBP 1.70 CAD per unit → 0.8 GBP per USD, exactly.
   10,000 USD is 8,000.00 GBP. 3,000 USD is 2,400.00 GBP. */
const MIDS = { USD: 1.36, GBP: 1.7 };

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
  await rendered(page, /Large cash \/ reportable threshold/i);
}

test("a baseline desk's Settings names the international rules and the converted amounts", async ({ page }) => {
  const prior = await pool.query(`SELECT id, fetched_at FROM market_rates`);
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-${stamp}`, `CD-B${String(stamp).slice(-6)}`, EMAIL, "Baseline Owner"],
  );
  await pool.query(
    `INSERT INTO market_rates (id, provider, mids, fetched_at)
     VALUES ($1, 'test', $2::jsonb, now())`,
    [SNAP, JSON.stringify(MIDS)],
  );

  try {
    const before = logSize();
    const started = await page.request.post("/api/signup", {
      data: {
        businessName: SHOP,
        ownerName: "Baseline Owner",
        email: EMAIL,
        password: "baseline-desk-2026",
        slug: SLUG,
        onboarding: { country: "Serbia", homeCurrency: "GBP", city: "Belgrade", plan: "full" },
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
    await expect(panel.getByTestId("baseline-pack")).toBeVisible();
    await expect(panel.getByText("International baseline (FATF)")).toBeVisible();
    await expect(panel.getByText("Your country's financial intelligence unit")).toBeVisible();
    await expect(panel.getByText("No named regulator")).toBeVisible();
    await expect(panel.getByText("Large cash record")).toBeVisible();
    await expect(panel.getByText("CASH-RECORD")).toBeVisible();
    await expect(panel.getByText("Suspicious transaction")).toBeVisible();
    await expect(panel.getByText("SUSPICIOUS")).toBeVisible();
    await expect(panel.getByText("Terrorist or sanctioned property")).toBeVisible();
    await expect(panel.getByText("SANCTIONS-STOP")).toBeVisible();

    const words = await panel.innerText();
    expect(words).not.toMatch(/\bFINTRAC\b/);
    expect(words).not.toMatch(/\bCanada\b/);
    expect(words).not.toMatch(/\bLCTR\b/);
    expect(words).not.toMatch(/\bEFTR\b/);
    expect(words).not.toMatch(/\bSTR\b/);

    await expect(panel.getByText("Following the international baseline: £8,000.00, which is 10,000 USD at today's market rate.")).toBeVisible();
    await expect(panel.getByText("Following the international baseline: £2,400.00, which is 3,000 USD at today's market rate.")).toBeVisible();

    /* A stricter line names the owner's figure and the converted baseline
       separately. Printing £5,000 next to "10,000 USD" would be false. */
    const stricter = await page.evaluate(() =>
      fetch("/api/ledger/desk-thresholds", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportThreshold: "5000.00" }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    );
    expect(stricter.status, JSON.stringify(stricter.body)).toBe(200);
    expect(stricter.body.reportThreshold.packValue).toBe("8000.00");
    expect(stricter.body.reportThreshold.posture).toBe("stricter");
    await page.reload();
    await landOnDesktop(page);
    if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
    await openComplianceSettings(page);
    await expect(page.getByTestId("compliance-jurisdiction").getByText(
      "Stricter than the international baseline. Your line is £5,000.00. The baseline is £8,000.00, which is 10,000 USD at today's market rate.",
    )).toBeVisible();

    /* Looser prints that same converted baseline, not the raw 10,000. */
    const looser = await page.evaluate(() =>
      fetch("/api/ledger/desk-thresholds", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportThreshold: "12000.00" }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    );
    expect(looser.status, JSON.stringify(looser.body)).toBe(200);
    expect(looser.body.reportThreshold.packValue).toBe("8000.00");
    await page.reload();
    await landOnDesktop(page);
    if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
    await openComplianceSettings(page);
    const looserPanel = page.getByTestId("compliance-jurisdiction");
    await expect(looserPanel.getByText("£12,000.00 — the international baseline requires no more than £8,000.00.")).toBeVisible();
    expect(await looserPanel.innerText()).not.toMatch(/no more than £10,000/);

    expect((await page.evaluate(() =>
      fetch("/api/ledger/desk-thresholds", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportThreshold: "pack_default" }),
      }).then((r) => r.status),
    ))).toBe(200);

    /* The transfer form prices a send in CAD. The lines are in home
       currency. 5,000 CAD is under a 300,000 dinar line as a raw number
       and over it once converted. No rate: ID is required, and the deal
       is not called reportable. */
    const ruling = await page.evaluate(() => {
      const rule = window.CDOS._transfers.transferRuling;
      return {
        over: rule({ cadAmount: 5000, home: "RSD", homePerCad: 100, idAt: 300000, limitAmount: 1000000, governed: true, fallback: 3000 }),
        under: rule({ cadAmount: 100, home: "RSD", homePerCad: 100, idAt: 300000, limitAmount: 1000000, governed: true, fallback: 3000 }),
        unvalued: rule({ cadAmount: 5000, home: "RSD", homePerCad: null, idAt: 300000, limitAmount: 1000000, governed: true, fallback: 3000 }),
        cad: rule({ cadAmount: 5000, home: "CAD", homePerCad: 1, idAt: 3000, limitAmount: 10000, governed: true, fallback: 3000 }),
      };
    });
    expect(ruling.over).toMatchObject({ homeAmount: 500000, idRequired: true, reportable: false });
    expect(ruling.under).toMatchObject({ homeAmount: 10000, idRequired: false, reportable: false });
    expect(ruling.unvalued).toMatchObject({ homeAmount: null, idRequired: true, reportable: null });
    expect(ruling.cad).toMatchObject({ homeAmount: 5000, idRequired: true, reportable: false });

    /* On this GBP desk, 3,000 CAD is about £1,700, under the £2,400 line.
       Compared as a raw 3,000 it would ask for ID. */
    await page.getByText(/^Transfers$/).first().click();
    const newTransfer = page.getByRole("button", { name: /New transfer/i }).first();
    await expect(newTransfer).toBeVisible({ timeout: 30_000 });
    await newTransfer.click();
    const form = page.locator("div.fixed.inset-0").filter({ has: page.getByRole("button", { name: /Create transfer/i }) });
    await form.getByPlaceholder("0.00").first().fill("3000");
    await expect(form.getByText(/ID required/i)).toHaveCount(0);

    /* Age every snapshot, including the one this test added. The newest
       row wins, so leaving an older fresh row in place would still
       convert. Restored below so the next file prices as it did. */
    await pool.query(`UPDATE market_rates SET fetched_at = now() - interval '25 hours'`);
    await page.reload();
    await landOnDesktop(page);
    if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
    await openComplianceSettings(page);
    const again = page.getByTestId("compliance-jurisdiction");
    await expect(again.getByText("Identification is required on every deal.")).toBeVisible();
    await expect(again.getByText("Purpose and source of funds are required on every deal.")).toBeVisible();
    const staleWords = await again.innerText();
    expect(staleWords).not.toMatch(/\bFINTRAC\b/);
    expect(staleWords).not.toMatch(/\bCanada\b/);
    expect(staleWords).not.toMatch(/at today's market rate/);
  } finally {
    await pool.query(`DELETE FROM market_rates WHERE id = $1`, [SNAP]);
    for (const row of prior.rows) {
      await pool.query(`UPDATE market_rates SET fetched_at = $2 WHERE id = $1`, [row.id, row.fetched_at]);
    }
  }
});
