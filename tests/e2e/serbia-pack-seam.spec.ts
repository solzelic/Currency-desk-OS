/* A new Serbian desk, on the screen and then on the ledger.

   The exchange line is 5,000 EUR. The NBS middle rate in this test is
   100 dinars per euro, so the line is 500,000.00 RSD. The market
   snapshot is only there so the board can publish. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, codeFor, logSize } from "./fixtures";

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
const EMAIL = `owner-${stamp}@serbia-seam.example`;
const SHOP = `Serbia Seam ${stamp}`;
const SLUG = `rseam${stamp}`;
const SNAP = `snap-serbia-seam-${stamp}`;
const MIDS = { USD: 1.36, RSD: 0.0125, EUR: 1.25 };

let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

test("a Serbia desk identifies at 5,000 EUR and shows the airside switch", async ({ page }) => {
  test.setTimeout(180_000);
  const prior = await pool.query(`SELECT id, fetched_at FROM market_rates`);
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-rs${stamp}`, `CD-R${String(stamp).slice(-6)}`, EMAIL, "Serbia Owner"],
  );
  await pool.query(
    `INSERT INTO market_rates (id, provider, mids, fetched_at)
     VALUES ($1, 'test', $2::jsonb, now())`,
    [SNAP, JSON.stringify(MIDS)],
  );
  await pool.query(
    `INSERT INTO nbs_middle_rates
       (id, rate_date, base_currency, quote_currency, middle_rate, fetched_at)
     VALUES ($1, (timezone('Europe/Belgrade', now()))::date, 'EUR', 'RSD', 100, timestamptz '2026-10-07 08:00:00+00')
     ON CONFLICT (rate_date, base_currency, quote_currency)
     DO UPDATE SET middle_rate = EXCLUDED.middle_rate, fetched_at = EXCLUDED.fetched_at`,
    [`nbs-serbia-seam-${stamp}`],
  );
  try {
    const before = logSize();
    const started = await page.request.post("/api/signup", {
      data: {
        businessName: SHOP,
        ownerName: "Serbia Owner",
        email: EMAIL,
        password: "serbia-desk-2026",
        slug: SLUG,
        onboarding: { country: "Serbia", regulator: "NBS / APML", plan: "full" },
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

    await expect.poll(() => page.evaluate(() => {
      const t = window.CDOS.deskThresholds && window.CDOS.deskThresholds();
      return t && t.idThreshold && t.idThreshold.effective;
    }), { timeout: 20_000 }).toBe("500000.00");

    await page.getByText(/^Settings$/i).first().click();
    await page.locator('div[style*="width: 212px"]').getByText(/Compliance & jurisdiction/i).first().click();
    const airside = page.getByTestId("serbia-airside");
    await expect(airside).toBeVisible();
    await expect(airside).toContainText("airside or inside a casino");
    await expect(page.getByText("Not added together").first()).toBeVisible();

    await page.getByText(/^Ledger$/).first().click();
    const opened = await page.evaluate(async () => {
      const res = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.ok || res.status === 409 ? "open" : `${res.status}`;
    });
    expect(opened).toBe("open");
    await page.reload();
    await landOnDesktop(page);
    if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
    await page.getByText(/^Ledger$/).first().click();
    const newDeal = page.getByRole("button", { name: /^New transaction$/i }).first();
    await expect(newDeal).toBeEnabled({ timeout: 30_000 });
    await newDeal.click();
    const form = page.locator("div.fixed.inset-0").filter({ has: page.getByText("Customer pays in") });
    await expect(form).toBeVisible();
    await expect(form.getByTestId("serbia-receipt")).toBeVisible();
    await expect(form.getByTestId("serbia-suspicion")).toContainText("do not post this deal");
    await expect(form.getByTestId("serbia-usd-notes")).toBeVisible();

    async function pick(current: string, next: string) {
      const tour = page.locator(".cdos-tour-skip");
      if (await tour.isVisible().catch(() => false)) await tour.click();
      await form.getByRole("button", { name: current, exact: true }).click();
      const option = page.locator("div[style*='z-index: 99998']").getByRole("button", { name: new RegExp(`^${next}\\b`) });
      await expect(option).toBeVisible();
      await option.evaluate((el: HTMLElement) => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(form.getByRole("button", { name: next, exact: true })).toBeVisible();
    }
    await pick("RSD", "EUR");
    await pick("USD", "RSD");
    await expect(form.getByTestId("serbia-usd-notes")).toHaveCount(0);
    await form.locator('input[placeholder="0.00"]').first().fill("5000");
    await expect(form.getByText(/ID required/i).first()).toBeVisible();
    await form.locator('input[placeholder="0.00"]').first().fill("100");
    await expect(form.getByText(/ID not needed/i)).toBeVisible();

    const posted = await page.evaluate(async () => {
      await fetch("/api/ledger/opening-balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { RSD: "2000000.00", EUR: "1000.00" } }),
      });
      const made = await fetch("/api/ledger/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalRef: "serbia-seam", name: "Unidentified Seller", risk: "normal", idStatus: "missing" }),
      }).then((r) => r.json());
      const quote = async (inputAmount: string) => {
        const res = await fetch("/api/quotes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customerId: made.customerId, from: "EUR", to: "RSD", inputAmount, feeCad: "0.00",
            direction: "customer_sell_foreign",
          }),
        });
        const body = await res.json();
        const post = await fetch(`/api/quotes/${body.quoteId}/post`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `serbia-seam-${inputAmount}`,
            purpose: "Personal travel",
            sourceOfFunds: "Employment income",
          }),
        });
        const postedBody = await post.json().catch(() => ({}));
        return { status: post.status, code: postedBody.code || null };
      };
      return { under: await quote("100.00"), over: await quote("5000.00") };
    });
    expect(posted.under.status, JSON.stringify(posted)).toBe(201);
    expect(posted.over.code, JSON.stringify(posted)).toBe("COMPLIANCE_BLOCKED");
  } finally {
    await pool.query(`DELETE FROM market_rates WHERE id = $1`, [SNAP]);
    await pool.query(
      `DELETE FROM nbs_middle_rates
        WHERE base_currency='EUR' AND quote_currency='RSD'
          AND fetched_at = timestamptz '2026-10-07 08:00:00+00'`,
    );
    for (const row of prior.rows) {
      await pool.query(`UPDATE market_rates SET fetched_at = $2 WHERE id = $1`, [row.id, row.fetched_at]);
    }
  }
});
