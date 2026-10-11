/* Long-tail phone template. Vault and Audit trail at 360 and 390.
   At 1280 the phone tree is not mounted, so the desktop is the one
   a wide window already had. */
import { createRequire } from "node:module";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop, hasLedger, ledger } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const shotDir = process.env.LONGTAIL_SHOTS || "";
const WIDTHS = [360, 390] as const;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function atDesk(page: Page, staffId = "a.singh"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, staffId);
  await dismissTour(page);
  await settled(page);
}

async function openMore(page: Page, id: string): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator("#phone-more")).toBeVisible();
  await page.locator(`#phone-more [data-phone-app="${id}"]`).click();
  await dismissTour(page);
  await settled(page);
}

async function backAboveTitle(screen: Locator): Promise<void> {
  const back = await screen.getByRole("button", { name: "More" }).boundingBox();
  const title = await screen.locator(".phone-title h1").boundingBox();
  expect(back && title && back.y < title.y).toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotDir) return;
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

function money(amount: string, code: string): string {
  const body = new Intl.NumberFormat("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount));
  return `${body} ${code}`;
}

/* The sheet offers the home currency plus USD, EUR and GBP. Prefer one
   of those when the safe holds enough to issue twice. */
function currencyToIssue(balances: Record<string, string>, need: number): string | null {
  const order = ["CAD", "USD", "EUR", "GBP"];
  const held = Object.entries(balances)
    .filter(([, amount]) => Number(amount) >= need)
    .map(([code]) => code)
    .sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  return held[0] || null;
}

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params: string[]) => Promise<unknown>;
    end: () => Promise<void>;
  };
};

/** Take this branch's vault rows off, and remember the figures. */
async function holdTheVaultAside(page: Page): Promise<Record<string, string> | null> {
  const vault = await ledger(page).vault();
  if (!vault.tracked) return null;
  const who = (await page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.json();
  })) as { user: { tenantId: string; legalEntityId: string; branchId: string } };
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query(
      `DELETE FROM ledger_vault_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3`,
      [who.user.tenantId, who.user.legalEntityId, who.user.branchId],
    );
  } finally {
    await pool.end();
  }
  return vault.balances as Record<string, string>;
}

async function putTheVaultBack(page: Page, balances: Record<string, string> | null) {
  if (!balances || Object.keys(balances).length === 0) return;
  const status = await page.evaluate(async (saved) => {
    const response = await fetch("/api/ledger/vault/opening-position", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balances: saved }),
    });
    return response.status;
  }, balances);
  expect(status).toBe(201);
}

test("desktop vault and audit trail have no phone template at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await page.locator('#appbar [data-app="vault"]').click();
  await settled(page);
  await expect(page.locator(".longtail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move cash", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Order", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Position", exact: true })).toBeVisible();
  await page.locator('#appbar [data-app="audit"]').click();
  await settled(page);
  await expect(page.locator(".longtail")).toHaveCount(0);
  await expect(page.locator("select").filter({ hasText: "All actions" })).toBeVisible();
  await expect(page.getByText("Example data")).toHaveCount(0);
});

test("audit trail lists and searches at 360 and 390", async ({ page }) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await atDesk(page, "a.singh");
    await openMore(page, "audit");
    const trail = page.locator('.longtail[data-app="audit"]');
    await expect(trail).toBeVisible();
    await expect(trail.getByRole("heading", { name: "Audit trail" })).toBeVisible();
    await expect(trail.locator(".phone-sticky")).toHaveCount(0);
    await expect(trail).not.toContainText("transaction.post");
    /* Signing in writes a row, so the newest line is that sign-in.
       The seeded deals stay underneath it. */
    await expect(trail.getByText("Actions on this device. The full audit trail is on a computer.")).toBeVisible();
    const titles = await trail.locator(".phone-row-title").allTextContents();
    const signed = titles.indexOf("A. Singh signed in");
    const posted = titles.indexOf("Transaction posted");
    expect(signed).toBeGreaterThanOrEqual(0);
    expect(posted).toBeGreaterThan(signed);
    await expect(trail.getByText("Signed in as")).toHaveCount(0);
    await expect(trail.getByText("2026-06-18")).toHaveCount(0);
    await expect(trail.getByText("Jun 18, 2026")).toBeVisible();
    await expect(trail.locator(".phone-row").first()).toContainText(/\d{1,2}:\d{2} (AM|PM)/);
    const chips = trail.locator(".phone-chips");
    const chipBox = await chips.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        scrolls: el.scrollWidth > el.clientWidth + 1,
        mask: style.maskImage || "",
      };
    });
    expect(chipBox.scrolls).toBe(true);
    expect(chipBox.mask).not.toBe("none");
    const back = trail.getByRole("button", { name: "More" });
    const backBox = await back.boundingBox();
    expect(backBox && backBox.height).toBeGreaterThanOrEqual(44);
    expect(backBox && backBox.width).toBeGreaterThanOrEqual(44);
    await backAboveTitle(trail);
    await expect(trail).not.toContainText(" pm");
    await expect(trail).not.toContainText(" p.m.");
    await shot(page, `longtail_audit_${width}`);
    await trail.getByLabel("Find an action, name or number").fill("Costa");
    await expect(trail.locator(".phone-row").first()).toContainText("Costa");
    await expect(trail.locator(".phone-row").first()).not.toContainText("A. Singh");
    await trail.getByLabel("Find an action, name or number").fill("no-such-entry-zz");
    await expect(trail.getByText("Nothing matches that search.")).toBeVisible();
    await expect(trail.locator(".phone-row")).toHaveCount(0);
    await trail.getByLabel("Find an action, name or number").fill("");
  }
  await phoneSweep(page, { roots: ['.longtail[data-app="audit"]'] });
});

test("a teller sees the audit trail and not the vault", async ({ page }) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await atDesk(page, "m.costa");
    await page.locator('#phonebar [data-phone-app="more"]').click();
    const labels = await page.locator("#phone-more .phone-more-name").allTextContents();
    expect(labels).toContain("Audit trail");
    expect(labels).not.toContain("Assistant");
    expect(labels).not.toContain("Vault");
    expect(labels).not.toContain("Reports");
    expect(labels).not.toContain("Dashboard");
    expect(labels).not.toContain("Settings");
    await page.locator('#phone-more [data-phone-app="audit"]').click();
    await dismissTour(page);
    await settled(page);
    const trail = page.locator('.longtail[data-app="audit"]');
    await expect(trail).toBeVisible();
    await expect(trail.getByRole("button", { name: "Give out a float" })).toHaveCount(0);
    await expect(trail).not.toContainText("transaction.post");
  }
});

test("assistant cannot be opened on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator("#phone-more")).toBeVisible();
  await expect(page.locator('#phone-more [data-phone-app="assistant"]')).toHaveCount(0);
  await page.getByLabel("Search apps").fill("assistant");
  await expect(page.locator('#phone-more [data-phone-app="assistant"]')).toHaveCount(0);
  await expect(page.getByText("No matches")).toBeVisible();
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await openMore(page, "store");
  const store = page.locator('.longtail[data-app="store"]');
  await expect(store.getByRole("heading", { name: "Open this on a computer" })).toBeVisible();
  await expect(store.getByText("Adding and removing apps is on a computer.")).toBeVisible();
  await expect(page.locator(".st-wrap")).toHaveCount(0);
  await expect(page.locator('.win[data-app="assistant"]')).toHaveCount(0);
});

test.describe("vault on a phone", () => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

  test("vault shows the ledger and a float posts once at 360 and 390", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await atDesk(page, "a.singh");
    const book = ledger(page);
    let vault = await book.vault();
    if (!vault.tracked) {
      const opened = await page.evaluate(async () => {
        const response = await fetch("/api/ledger/vault/opening-position", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ balances: { CAD: "5000.00", USD: "200.00" } }),
        });
        return response.status;
      });
      expect(opened, "opening position").toBe(201);
      await page.reload();
      await landOnDesktop(page);
      await dismissTour(page);
      vault = await book.vault();
    }
    expect(vault.tracked).toBe(true);
    const code = currencyToIssue(vault.balances as Record<string, string>, 2);
    expect(code, "a currency with enough on hand to issue twice").toBeTruthy();
    const issued = code as string;

    const session = await page.evaluate(async () => {
      const probe = await fetch("/api/ledger/till-session");
      const body = await probe.json().catch(() => ({}));
      if (body.session && body.session.status === "open") return "open";
      const response = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.ok || response.status === 409 ? "open" : `${response.status}`;
    });
    expect(session).toBe("open");

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
      const fresh = await book.vault();
      const amount = (fresh.balances as Record<string, string>)[issued];
      expect(Number(amount)).toBeGreaterThanOrEqual(1);
      await openMore(page, "vault");
      const screen = page.locator('.longtail[data-app="vault"]');
      await expect(screen).toBeVisible();
      await expect(screen.getByRole("heading", { name: "Vault" })).toBeVisible();
      await expect(screen.getByText("Example data")).toHaveCount(0);
      await expect(screen.locator("#phone-fab")).toHaveCount(0);
      await expect(screen.locator(`[data-currency="${issued}"]`)).toContainText(money(amount, issued));
      await expect(screen.getByRole("button", { name: "More" })).toBeVisible();
      const fill = await screen.locator(".phone-sticky-btn").evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(fill).toBe("rgb(23, 20, 15)");
      const back = screen.getByRole("button", { name: "More" });
      const backType = await back.evaluate((el) => {
        const style = getComputedStyle(el);
        const svg = el.querySelector("svg");
        const box = svg ? svg.getBoundingClientRect() : null;
        return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight, w: box && box.width, h: box && box.height };
      });
      expect(backType).toEqual({ size: "16px", line: "24px", weight: "600", w: 24, h: 24 });
      await backAboveTitle(screen);
      const cap = screen.locator(".phone-stat-cap");
      await expect(cap).toHaveText(/^\d+ currenc(?:y|ies) · mid-market rate, \d{1,2}:\d{2} (AM|PM)$/);
      await expect(cap).not.toContainText("\u2014");
      await expect(cap).not.toContainText("\u2013");
      await expect(screen.getByText("Running low")).toHaveCount(0);
      await expect(screen.getByText("Canadian dollar")).toBeVisible();
      await expect(screen.getByText("No rate yet")).toHaveCount(0);
      await shot(page, `longtail_vault_${width}`);

      const before = Number((await book.till())[issued] || 0);
      await screen.getByRole("button", { name: "Give out a float" }).click();
      const sheet = page.getByRole("dialog", { name: "Give out a float" });
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: /A till/ }).click();
      if (!["CAD", "USD", "EUR", "GBP"].includes(issued) && issued !== "CAD") {
        await sheet.getByLabel("Add a currency").selectOption(issued);
      }
      /* The amount starts empty, placeholder 0.00. The test types 1.00
         after the shot so the till movement can be checked. */
      await shot(page, `longtail_float_${width}`);
      await sheet.getByLabel(`${issued} amount`).fill("1.00");
      const give = sheet.getByRole("button", { name: /Give float to / });
      /* The previous width leaves "Float given" on screen for four
         seconds. Wait for this post, and for the till to move, not
         for that status text. */
      const posted = page.waitForResponse((res) => {
        return res.request().method() === "POST" && new URL(res.url()).pathname === "/api/ledger/till-movements" && res.ok();
      });
      await give.dblclick();
      await posted;
      await expect(sheet).toBeHidden({ timeout: 20_000 });
      await expect.poll(async () => Number((await book.till())[issued] || 0), { timeout: 20_000 }).toBeCloseTo(before + 1, 2);
      await expect(page.getByText("Open the vault with a starting count first.")).toHaveCount(0);
    }
    const screen = page.locator('.longtail[data-app="vault"]');
    await page.evaluate(() => {
      const raw = localStorage.getItem("yorkfx_rates_v1");
      const cfg = raw ? JSON.parse(raw) : {};
      delete cfg.publishedAt;
      localStorage.setItem("yorkfx_rates_v1", JSON.stringify(cfg));
      window.dispatchEvent(new StorageEvent("storage", { key: "yorkfx_rates_v1" }));
    });
    const quiet = screen.locator(".phone-stat-cap");
    await expect(quiet).toHaveText(/^\d+ currenc(?:y|ies) · mid-market rate$/);
    await expect(quiet).not.toContainText("\u2014");
    await expect(quiet).not.toContainText("\u2013");
    await expect(quiet).not.toContainText(",");
    /* A double tap can reopen Give out a float after the sheet closes.
       Do not click Cancel: a ledger poll re-renders that sheet and the
       click never settles. The empty amount placeholders are dark
       enough for the sweep either way. */
    await phoneSweep(page, { roots: ['.longtail[data-app="vault"]'] });
  });

  test("a float from an unopened vault is refused at 360 and 390", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await atDesk(page, "a.singh");
    const saved = await holdTheVaultAside(page);
    try {
      const book = ledger(page);
      expect((await book.vault()).tracked).toBe(false);
      await page.reload();
      await landOnDesktop(page);
      await dismissTour(page);
      const opened = await page.evaluate(async () => {
        const probe = await fetch("/api/ledger/till-session");
        const body = await probe.json().catch(() => ({}));
        if (body.session && body.session.status === "open") return "open";
        const response = await fetch("/api/ledger/till-sessions/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        return response.ok || response.status === 409 ? "open" : `${response.status}`;
      });
      expect(opened).toBe("open");

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
        const before = await book.till();
        await openMore(page, "vault");
        const screen = page.locator('.longtail[data-app="vault"]');
        await expect(screen.getByRole("heading", { name: "No opening count yet" })).toBeVisible();
        await expect(screen.getByText("Count the safe once so the vault knows what it holds.")).toBeVisible();
        await expect(screen.getByRole("button", { name: "Count the vault" })).toBeVisible();
        await expect(screen).not.toContainText("\u2014");
        await expect(screen).not.toContainText("\u2013");
        await expect(screen.getByRole("button", { name: "Give out a float" })).toHaveCount(0);
        await backAboveTitle(screen);
        await shot(page, `longtail_empty_${width}`);
        expect(await book.till()).toEqual(before);
        await expect(page.getByRole("status").filter({ hasText: "Float given to" })).toHaveCount(0);
      }
      await phoneSweep(page, { roots: ['.longtail[data-app="vault"]'] });
    } finally {
      await putTheVaultBack(page, saved);
    }
  });
});
