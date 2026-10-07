/* ============================================================
   The two screens green CI never opened on a non-CAD desk.

   Branch Network crashed on every desk, Canada included, because
   the currency list called itself. The new-transaction form valued
   foreign cash at 0 on any other desk, so 5,000 euros handed over
   a Belgrade counter read as "No ID needed". Neither showed up in
   the seam suite, because nothing opened that window or took
   foreign notes on a dinar desk that has no country pack. Serbia now
   has its own pack, so this desk is a Philippine shop keeping dinars.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, codeFor, logSize } from "./fixtures";
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
const EMAIL = `owner-${stamp}@foreign-desk-seam.example`;
const SHOP = `Foreign Desk ${stamp}`;
const SLUG = `fseam${stamp}`;
const SNAP = `snap-foreign-desk-${stamp}`;
/* USD 1.36 and RSD 0.0125 → 108.8 dinars per dollar. The cash-exchange
   identification line is 3,000 USD = 326,400.00 RSD. EUR 1.25 CAD is
   exactly 100 dinars per euro, so 5,000 euros is 500,000 dinars (over
   the line) and 100 euros is 10,000 (under it). */
const MIDS = { USD: 1.36, RSD: 0.0125, EUR: 1.25 };

let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (!pool) return;
  await pool.end();
});

function watchCrashes(page: Page) {
  const crashes: string[] = [];
  page.on("pageerror", (err) => crashes.push(err.message));
  return crashes;
}

async function openBranchNetwork(page: Page, home: string) {
  await page.getByText("Branch Network").first().click();
  const win = page.locator(".win.show.active");
  await expect(win.getByText("Branch Network").first()).toBeVisible({ timeout: 15_000 });
  await expect(win.getByText(`Network cash · ${home}`)).toBeVisible();
}

test("Branch Network opens on a Canada desk", async ({ page }) => {
  const crashes = watchCrashes(page);
  await signInAtDesk(page, "j.masri");
  await openBranchNetwork(page, "CAD");
  expect(crashes.join("\n")).not.toMatch(/Maximum call stack/i);
});

test("an RSD desk opens Branch Network, and selling EUR 5,000 asks for ID the way the server does", async ({ page }) => {
  test.setTimeout(180_000);
  const crashes = watchCrashes(page);
  const prior = await pool.query(`SELECT id, fetched_at FROM market_rates`);
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-f${stamp}`, `CD-F${String(stamp).slice(-6)}`, EMAIL, "Foreign Owner"],
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
        ownerName: "Foreign Owner",
        email: EMAIL,
        password: "foreign-desk-2026",
        slug: SLUG,
        onboarding: { country: "Philippines", homeCurrency: "RSD", city: "Manila", plan: "full" },
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

    await openBranchNetwork(page, "RSD");
    expect(crashes.join("\n")).not.toMatch(/Maximum call stack/i);

    /* A closed day disables New transaction. Open the till through the
       same route the desk uses, then come back to the desktop so the
       button is the one a teller would press. */
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
    await page.reload();
    await landOnDesktop(page);
    if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

    await expect.poll(() => page.evaluate(() => {
      const t = window.CDOS.deskThresholds && window.CDOS.deskThresholds();
      return t && t.idThreshold && t.idThreshold.effective;
    }), { timeout: 20_000 }).toBe("326400.00");
    await expect.poll(() => page.evaluate(() => {
      try {
        const cfg = JSON.parse(localStorage.getItem("yorkfx_rates_v1") || "null");
        const mid = cfg && cfg.rows && cfg.rows.EUR && cfg.rows.EUR.mid;
        const inr = cfg && cfg.rows && cfg.rows.INR;
        return mid > 0 && !inr ? Number(mid) : 0;
      } catch (e) { return 0; }
    }), { timeout: 20_000 }).toBeGreaterThan(0);

    await page.getByText(/^Ledger$/).first().click();
    const newDeal = page.getByRole("button", { name: /^New transaction$/i }).first();
    await expect(newDeal).toBeEnabled({ timeout: 30_000 });
    await newDeal.click();
    const form = page.locator("div.fixed.inset-0").filter({ has: page.getByText("Customer pays in") });
    await expect(form).toBeVisible();

    /* The form opens on the desk's own currency paying in, and USD
       paying out — not CAD. The menu is portaled, and it closes on
       mousedown, so a normal click unmounts the option before the
       click lands. A click event on the option is what the teller
       selects. */
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
    await form.locator('input[placeholder="0.00"]').first().fill("5000");
    await expect(form.getByText(/ID required/i).first()).toBeVisible();
    await expect(form.getByText(/ID not needed/i)).toHaveCount(0);

    const over = await page.evaluate(async () => {
      const opened = await fetch("/api/ledger/opening-balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { RSD: "200000.00", EUR: "1000.00" } }),
      });
      const session = await fetch("/api/ledger/till-session").then((r) => r.json());
      if (session.session?.status !== "open") {
        await fetch("/api/ledger/till-sessions/open", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
      }
      const made = await fetch("/api/ledger/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalRef: "eur-sell-seam", name: "Unidentified Seller", risk: "normal", idStatus: "missing" }),
      }).then((r) => r.json());
      const quote = async (inputAmount: string, from: string) => {
        const res = await fetch("/api/quotes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            customerId: made.customerId, from, to: "RSD", inputAmount, feeCad: "0.00",
            direction: "customer_sell_foreign",
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { status: res.status, code: body.code, body };
        const post = await fetch(`/api/quotes/${body.quoteId}/post`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `seam-${from}-${inputAmount}`,
            purpose: "Personal travel",
            sourceOfFunds: "Employment income",
          }),
        });
        const posted = await post.json().catch(() => ({}));
        return { status: post.status, code: posted.code, marketMid: body.marketMid, posted };
      };
      const cfg = JSON.parse(localStorage.getItem("yorkfx_rates_v1") || "null");
      return {
        boardEur: cfg && cfg.rows && cfg.rows.EUR && cfg.rows.EUR.mid,
        opening: opened.status,
        sell: await quote("5000.00", "EUR"),
      };
    });
    /* The board cache keeps the published mid as a number (100). The
       quote stores the same mid at 12 decimal places. Same rate. */
    expect(Number(over.boardEur)).toBe(Number(over.sell.marketMid));
    expect(over.sell.status, JSON.stringify(over.sell)).toBe(422);
    expect(over.sell.code).toBe("COMPLIANCE_BLOCKED");

    await form.locator('input[placeholder="0.00"]').first().fill("100");
    /* A walk-in under the line is named, not identified: "ID not needed". */
    await expect(form.getByText(/ID not needed/i)).toBeVisible();
    await expect(form.getByText(/ID required/i)).toHaveCount(0);

    const under = await page.evaluate(async () => {
      const customers = await fetch("/api/ledger/customers").then((r) => r.json());
      const customerId = (customers.customers || []).find((c: { name?: string }) => c.name === "Unidentified Seller")?.customerId;
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId, from: "EUR", to: "RSD", inputAmount: "100.00", feeCad: "0.00",
          direction: "customer_sell_foreign",
        }),
      });
      const body = await res.json();
      const post = await fetch(`/api/quotes/${body.quoteId}/post`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "seam-EUR-100.00",
          purpose: "Personal travel",
          sourceOfFunds: "Employment income",
        }),
      });
      const posted = await post.json().catch(() => ({}));
      return { status: post.status, code: posted.code || null };
    });
    expect(under.code, JSON.stringify(under)).not.toBe("COMPLIANCE_BLOCKED");
    expect(under.status).toBe(201);

    await pick("EUR", "INR");
    await form.locator('input[placeholder="0.00"]').first().fill("100");
    await expect(form.getByText(/ID required/i).first()).toBeVisible();
    await expect(form.getByText(/ID not needed/i)).toHaveCount(0);

    const missing = await page.evaluate(async () => {
      const customers = await fetch("/api/ledger/customers").then((r) => r.json());
      const customerId = (customers.customers || []).find((c: { name?: string }) => c.name === "Unidentified Seller")?.customerId;
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId, from: "INR", to: "RSD", inputAmount: "100.00", feeCad: "0.00",
          direction: "customer_sell_foreign",
        }),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, code: body.code };
    });
    expect(missing.status).toBe(422);
    expect(missing.code).toBe("RATE_NOT_AVAILABLE");
  } finally {
    await pool.query(`DELETE FROM market_rates WHERE id = $1`, [SNAP]);
    for (const row of prior.rows) {
      await pool.query(`UPDATE market_rates SET fetched_at = $2 WHERE id = $1`, [row.id, row.fetched_at]);
    }
  }
});
