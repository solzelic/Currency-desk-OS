/* A new Australian desk opens on the current rules, and a desk still
   on the published pack can opt in without the screen inventing an
   IFTI or a 24 hour cash rule. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, codeFor, logSize } from "./fixtures";
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
const EMAIL = `owner-${stamp}@australia-pack-seam.example`;
const SLUG = `auseam${stamp}`;
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

async function openAustralia(page: Page) {
  await page.goto("/app");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await expect.poll(() => page.evaluate(() => {
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    return pack && pack.packId;
  }), { timeout: 20_000 }).toBe("pack-au-v2");
  await page.getByText(/^Compliance$/).first().click();
  const win = page.locator(".win.show.active");
  await expect(win.getByText("Compliance").first()).toBeVisible();
  return win;
}

test("a new Australian desk shows IVTS and a single-transaction TTR, and opt-in leaves a posted deal on v1", async ({ page }) => {
  test.setTimeout(180_000);
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-au${stamp}`, `CD-A${String(stamp).slice(-6)}`, EMAIL, "Australia Owner"],
  );
  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: `Australia Desk ${stamp}`,
      ownerName: "Australia Owner",
      email: EMAIL,
      password: "australia-pack-2026",
      slug: SLUG,
      onboarding: { country: "Australia", homeCurrency: "AUD", city: "Sydney", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);

  const win = await openAustralia(page);
  await win.locator("button.fld-tab").filter({ hasText: /Jurisdiction/ }).click();
  await expect(win.getByText("IVTS").first()).toBeVisible();
  await expect(win.getByText(/received or paid/i).first()).toBeVisible();
  await expect(win.getByText("IFTI")).toHaveCount(0);
  await win.locator("button.fld-tab").filter({ hasText: /Threshold reports/ }).click();
  await expect(win.getByText(/not added together/i)).toBeVisible();
  await expect(win.getByText(/24-hour rule/i)).toHaveCount(0);

  /* An existing desk, still on the published pack, with a deal already
     stamped. Opt-in is the only way it moves, and the stamp stays. */
  await pool.query(
    `UPDATE legal_entities
        SET jurisdiction_pack_id = 'pack-au-v1', jurisdiction_pack_version = 1
      WHERE id = $1`,
    [ENTITY],
  );
  await pool.query(
    `INSERT INTO ledger_transactions
       (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
        workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
        input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
        source_of_funds, posted_at, deal_kind, received_instrument, disbursed_instrument,
        jurisdiction_pack_id, jurisdiction_pack_version, home_currency)
     VALUES
       ($1, $2, $3, $4, 'br-seam', 'ws-seam', 'till-seam', 'cust-seam', 'seam',
        'AUD', 'USD', 20.00, 12.00, 1.5, 0, 0, 'travel', 'salary', now(),
        'exchange', 'cash', 'cash', 'pack-au-v1', 1, 'AUD')`,
    [`tx-au-${stamp}`, `ref-au-${stamp}`, `tnt-${SLUG}`, ENTITY],
  );

  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await expect.poll(() => page.evaluate(() => {
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    return pack && pack.packId;
  }), { timeout: 20_000 }).toBe("pack-au-v1");
  await page.getByText(/^Compliance$/).first().click();
  const again = page.locator(".win.show.active");
  await again.locator("button.fld-tab").filter({ hasText: /Jurisdiction/ }).click();
  await again.getByRole("button", { name: "Switch to the current AUSTRAC rules" }).click();
  await expect.poll(() => page.evaluate(() => {
    const pack = window.CDOS.deskPack && window.CDOS.deskPack();
    return pack && pack.packId;
  }), { timeout: 20_000 }).toBe("pack-au-v2");

  const stampRow = await pool.query(
    `SELECT jurisdiction_pack_id, jurisdiction_pack_version
       FROM ledger_transactions WHERE transaction_id = $1`,
    [`tx-au-${stamp}`],
  );
  expect(stampRow.rows[0]).toEqual({
    jurisdiction_pack_id: "pack-au-v1",
    jurisdiction_pack_version: 1,
  });
  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await page.getByText(/^Compliance$/).first().click();
  const after = page.locator(".win.show.active");
  await after.locator("button.fld-tab").filter({ hasText: /Jurisdiction/ }).click();
  await expect(after.getByText("IVTS").first()).toBeVisible();
  await expect(after.getByRole("button", { name: "Switch to the current AUSTRAC rules" })).toHaveCount(0);
});
