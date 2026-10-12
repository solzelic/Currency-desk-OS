/* ============================================================
   Where the screen meets the book.

   Every cash defect this project has had lived here, and every one of them
   survived a fully green test run, because the server suite tested the
   ledger, the journey suite tested the desk, and nothing tested the join.
   Two books do not crash. They disagree, quietly, and the daily close
   overwrites the evidence that they did.

   So each test below does one thing and then asks BOTH sides what happened.
   The close test in particular is the one that matters: an earlier version
   of the drawer sent "0.00" for any currency nobody had counted, and the
   server dutifully wrote zero over real money. That bug passed every test
   in the repository.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const OPENING = { CAD: "25000.00", USD: "12000.00" };

function deskPick(parts: Intl.DateTimeFormatPart[], type: string) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/* Same parts the drawer uses. A locale's own punctuation is "06:09 a.m." */
function deskTime(at: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(at));
  return `${deskPick(parts, "hour")}:${deskPick(parts, "minute")} ${deskPick(parts, "dayPeriod")}`;
}

function closeDayHeading(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
  return `Close the day, ${deskPick(parts, "weekday")} ${deskPick(parts, "month")} ${deskPick(parts, "day")}`;
}

/* "Oct 12". The stored business date stays YYYY-MM-DD. */
function deskDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
  return `${deskPick(parts, "month")} ${deskPick(parts, "day")}`;
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** Read what the Cash Drawer is telling the teller it holds, in CAD. */
async function drawerChip(page: Page) {
  const body = await page.locator("body").innerText();
  const match = body.match(/In drawer\s*\$([\d,]+(?:\.\d+)?)/);
  return match ? Number(match[1]!.replace(/,/g, "")) : null;
}

/* The Cash Drawer header reflows as the session, the drawer figures and
   the drawer name arrive, and the OS shell hides `.fld-bar` on downward
   scroll (0.3s max-height / transform). Playwright then reports a tab
   click as "not stable" or intercepted by the header that names till-01
   (`div.px-4.pt-3.flex-none`). That is issue #36: the close assertion
   never ran. Wait for the chrome to finish moving; do not force:true. */
async function settleCashDrawerChrome(page: Page) {
  await expect(page.locator(".till-which")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/figures are in/i)).toBeVisible();
  const scroller = page.locator(".win-body .overflow-auto").first();
  if (await scroller.count()) {
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  const tabBar = page.locator(".win-body .fld-bar").first();
  await expect(tabBar).toBeVisible();
  await expect(tabBar).not.toHaveClass(/fld-hidden/);
}

async function clickWhenStable(locator: Locator) {
  /* Scrolling the drawer down hides `.fld-bar` (pointer-events: none).
     A trial click then never lands. The tabs and the open button sit in
     the header, so the scroller stays at the top for the click. */
  await expect(async () => {
    const scroller = locator.page().locator(".win.show.active .win-body .overflow-auto").first();
    if (await scroller.count()) {
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
    }
    await expect(locator).toBeVisible();
    await locator.click({ trial: true });
  }).toPass({ timeout: 15_000 });
  await locator.click();
}

async function clickDrawerTab(page: Page, name: RegExp) {
  await settleCashDrawerChrome(page);
  await clickWhenStable(page.getByRole("button", { name }).first());
}

async function saveDrawerCount(page: Page) {
  await page.getByRole("button", { name: /Save count/i }).first().click();
  /* Save is a server round-trip. The button goes Saving… → Saved and the
     header tally updates; clicking Reconcile during that reflow is the
     flake. */
  await expect(page.getByRole("button", { name: /^Saved$/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await settleCashDrawerChrome(page);
}

async function openCashDrawer(page: Page) {
  /* The ledger's closed-day line says "Till & Cash Drawer". That is
     the first match for those words, and clicking it leaves the
     drawer shut. The dock tab is the control that opens it. */
  const tab = page.locator('#appbar [data-app="till"]');
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await expect(page.locator(".win.show.active .win-title", { hasText: /Cash drawer/i })).toBeVisible();
  await settleCashDrawerChrome(page);
}

/* A cell that is only a dash, or that contains an em or en dash.
   A negative amount uses a hyphen and is a figure, so it stays. */
function dashFault(text: string): string | null {
  if (/[—–]/.test(text)) return `dash in ${JSON.stringify(text)}`;
  if (text.trim() && /^[\s\-−]+$/.test(text)) return `lone dash ${JSON.stringify(text)}`;
  return null;
}

async function inside(locator: Locator, label: string): Promise<void> {
  const faults = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return ["not on screen"];
    const faults: string[] = [];
    const view = window.innerWidth;
    if (el.scrollWidth > el.clientWidth + 1) faults.push(`scroll ${el.scrollWidth} > ${el.clientWidth}`);
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    if (text.width > 0) {
      if (text.right > view + 1) faults.push(`past the viewport ${Math.round(text.right)} > ${view}`);
      if (text.left < -1) faults.push("past the left edge");
      let node: HTMLElement | null = el;
      while (node) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "hidden" || overflow === "clip") {
          const parent = node.getBoundingClientRect();
          if (text.right > parent.right + 1.5) faults.push(`clipped by ${node.className || node.tagName}`);
        }
        node = node.parentElement;
      }
    }
    return faults;
  });
  expect(faults, label).toEqual([]);
}

test("the phone close and the sign-off stay whole at 360, 390 and 430", async ({ page }) => {
  test.setTimeout(150_000);
  const widths = [
    { width: 360, height: 780 },
    { width: 390, height: 844 },
    { width: 430, height: 844 },
  ] as const;
  await page.setViewportSize(widths[0]);
  await signInAtDesk(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();

  for (const size of widths) {
    await page.setViewportSize(size);
    await page.locator('#phonebar [data-phone-app="till"]').click();
    await expect(page.locator(".till-screen")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".till-drawer-note")).toBeVisible();
    const note = page.locator(".till-drawer-note");
    await expect(note).toHaveText(/^No open session/);
    expect(await note.innerText()).not.toMatch(/sessi…|nobody on this till/);
    await inside(note, `${size.width} drawer note`);
    const strip = page.locator(".till-screen > .flex.justify-between").filter({ has: note });
    expect(dashFault(await strip.innerText()), `${size.width} drawer bar`).toBeNull();

    const history = page.locator('[data-tour="till"] .fld-tab', { hasText: "History" });
    await expect(history).toBeVisible();
    expect(await history.innerText()).toContain("History");
    expect(await history.innerText()).not.toMatch(/Hist…|Hist\.\.\./);
    await inside(history, `${size.width} History tab`);
    const fade = await page.locator('[data-tour="till"] .fld-bar').evaluate((el) => {
      const mask = getComputedStyle(el).maskImage;
      const after = getComputedStyle(el.parentElement!, "::after").content;
      return { mask, after };
    });
    expect(fade.mask, `${size.width} History fade`).toBe("none");
    expect(fade.after, `${size.width} History edge`).toBe("none");

    await clickWhenStable(page.getByRole("button", { name: "Count & close", exact: true }));
    const table = page.locator(".till-close-table");
    await expect(table).toBeVisible();
    const figure = table.locator("tbody td:last-child, tfoot td");
    const count = await figure.count();
    for (let i = 0; i < count; i++) {
      const cell = figure.nth(i);
      const text = (await cell.innerText()).trim();
      expect(dashFault(text), `${size.width} ${text}`).toBeNull();
      if (text) await inside(cell, `${size.width} ${text}`);
    }
    for (const header of ["Counted now", "Variance"]) {
      const th = table.locator("th", { hasText: header });
      await inside(th, `${size.width} ${header}`);
    }

    await page.evaluate(() => window.CDOS.openApp("reports"));
    const reports = page.locator(".win.show.active");
    await reports.getByRole("button", { name: /End-of-Day Sign-Off/ }).click();
    const doc = page.locator("#cdos-report-doc");
    await expect(doc).toBeVisible({ timeout: 30_000 });
    await expect(doc).toContainText("Till 1, Main counter");
    expect(await doc.innerText()).not.toMatch(/Till 1\s*[—–-]\s*Main counter/);
    const earned = doc.locator('.signoff-kpi[data-kpi="Earned today"]');
    await expect(earned).toBeVisible();
    await inside(earned, `${size.width} Earned today`);
    const money = await earned.locator(".signoff-kpi-value").evaluate((el) => {
      const doc = document.getElementById("cdos-report-doc");
      if (!doc) return { ok: false, why: "no sheet" };
      const probe = el.cloneNode(true) as HTMLElement;
      probe.textContent = "$22.51";
      probe.style.visibility = "hidden";
      probe.style.position = "absolute";
      el.parentElement?.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      const left = el.getBoundingClientRect().left;
      probe.remove();
      const edge = doc.getBoundingClientRect().right;
      const view = window.innerWidth;
      const end = left + width;
      return { ok: end <= edge + 1 && end <= view + 1, end, edge, view, width };
    });
    expect(money.ok, `${size.width} Earned today $22.51 ${JSON.stringify(money)}`).toBe(true);
  }
});

test("the desk opens a till session, and the ledger is the one that says so", async ({ page }) => {
  await signInAtDesk(page);
  const book = ledger(page);
  await book.ensureOpeningBalances(OPENING);
  await openCashDrawer(page);

  /* No session yet: the drawer must ASK rather than opening one because
     somebody looked at the screen. Asserted, not probed — an earlier draft
     of this test checked `isVisible()` and quietly skipped the click while
     the balances were still loading, which is the kind of test that reports
     green for a screen it never exercised. */
  const openButton = page.getByRole("button", { name: /Open the till/i }).first();
  await expect(openButton).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/hasn.t been opened/i)).toBeVisible();
  expect(await book.session()).toBeNull();
  await clickWhenStable(openButton);

  await expect(page.getByText(/Session #\d+ open/)).toBeVisible({ timeout: 15_000 });
  const session = await book.session();
  expect(session).not.toBeNull();
  expect(session.status).toBe("open");

  // the number on screen is the ledger's number, not one derived beside it
  const balances = await book.till();
  expect(Number(balances.CAD)).toBe(25000);
  expect(await drawerChip(page)).toBeGreaterThan(0);

  /* The close panel is headed with the session's trading day, and the
     session line prints the open time as 6:09 AM, not 06:09 a.m. */
  await clickDrawerTab(page, /Count & close/i);
  const heading = closeDayHeading(session.businessDate);
  await expect(page.getByText(heading, { exact: true })).toBeVisible();
  await expect(page.getByText(/Reconcile & close — Day/)).toHaveCount(0);
  await expect(page.getByText(/authoritative server till balance/i)).toHaveCount(0);
  await expect(
    page.getByText("Expected is what the system says should be in the drawer. Counted is what you count.", {
      exact: true,
    }),
  ).toBeVisible();

  const sessionLine = await page.locator(".till-sessionline").innerText();
  const opened = deskTime(session.openedAt);
  const day = deskDay(session.businessDate);
  expect(sessionLine).toContain(opened);
  expect(sessionLine).toContain(day);
  expect(sessionLine).not.toMatch(/a\.m\.|p\.m\./);
  /* A stored business date is YYYY-MM-DD. The session line must not show it. */
  expect(sessionLine).not.toMatch(ISO_DATE);
  expect(opened).toMatch(/^[1-9]\d?:\d{2} (AM|PM)$/);

  await expect(page.locator(".till-operator")).toHaveText("On the drawer: A. Singh, Senior teller");

  /* Drawers, not currencies. The seeded desk has one till, so the line is
     "0 of 1 counted" and "Count the drawer". Specs earlier in this suite
     add tills and leave them, and then the same screen says "0 of 3
     counted" and "Count all 3 drawers". Either reading is the branch's
     tills. Counting the two currencies (CAD and USD) is the bug. */
  const roster = await page.evaluate(async () => {
    const response = await fetch("/api/ledger/workspaces", { credentials: "same-origin" });
    return response.json() as { workspaces?: unknown[] };
  });
  const drawers = Math.max(1, Array.isArray(roster.workspaces) ? roster.workspaces.length : 0);
  const currencies = Object.keys(balances).length;
  const label = `0 of ${drawers} counted`;
  const status = page.locator(".till-statusline");
  const strip = page.locator(".till-session-count");
  const chip = page.locator(".till-count-chip");
  await expect(status).toContainText(label);
  await expect(strip).toHaveText(label);
  await expect(chip).toHaveText(label);
  /* A slash count is the old currency fraction (0/2). Any of the three
     places using it, or a different total, is the mismatch. */
  const pair = (text: string) => {
    const of = text.match(/(\d+) of (\d+) counted/);
    const slash = text.match(/(\d+)\/(\d+)/);
    return {
      done: of?.[1] ?? slash?.[1] ?? "",
      total: of?.[2] ?? slash?.[2] ?? "",
      slash: Boolean(slash),
    };
  };
  const statusCount = pair(await status.innerText());
  const stripCount = pair(await strip.innerText());
  const chipCount = pair(await chip.innerText());
  expect(stripCount, "the session strip uses the session line's count").toEqual(statusCount);
  expect(chipCount, "the heading chip uses the session line's count").toEqual(statusCount);
  expect(statusCount.slash, "the count is tills, not a currency fraction").toBe(false);
  expect(statusCount.total).toBe(String(drawers));
  if (drawers !== currencies) {
    expect(statusCount.total).not.toBe(String(currencies));
    await expect(strip).not.toContainText(`0/${currencies}`);
    await expect(chip).not.toContainText(`0/${currencies}`);
  }
  const countBeforeClose =
    drawers === 1
      ? "Count the drawer before closing. Your count becomes the new till balance."
      : `Count all ${drawers} drawers before closing. Your count becomes the new till balance.`;
  await expect(page.getByRole("button", { name: "Close the day", exact: true }).first()).toBeVisible();
  await expect(page.getByText(countBeforeClose)).toBeVisible();
  await expect(
    page.getByText("Closing saves your count. Any difference is recorded under your name.", { exact: true }),
  ).toBeVisible();

  /* CAD is two decimal places. 25000 must read 25,000.00. A formatter
     that only sets a maximum prints 25,000, and a one-place total such
     as 23,640.7 fails the single-decimal check below. */
  const money = (v: number) =>
    v.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const reconcile = page.locator("[data-tour='till-reconcile']");
  await expect(reconcile).toContainText(money(Number(balances.CAD)));
  await expect(reconcile).toContainText(money(Number(balances.USD)));
  const reconcileText = await reconcile.innerText();
  expect(reconcileText, "money keeps every decimal place its currency has").not.toMatch(/\d\.\d(?!\d)/);
});

test("a float moves the vault and the till together, or not at all", async ({ page }) => {
  await signInAtDesk(page);
  const book = ledger(page);
  await openCashDrawer(page);

  const vaultBefore = await book.vault();
  test.skip(!vaultBefore.tracked, "vault opening position is covered by the vault suite");
  const tillBefore = await book.till();

  await clickWhenStable(page.getByRole("button", { name: /^Move cash$/i }).first());
  await page.locator('input[placeholder="0"]').last().fill("2000");
  await page.getByRole("button", { name: /Issue float/i }).last().click();

  await expect
    .poll(async () => Number((await book.till()).CAD), { timeout: 15_000 })
    .toBe(Number(tillBefore.CAD) + 2000);

  // the other end of the same movement
  const vaultAfter = await book.vault();
  expect(Number(vaultAfter.balances.CAD)).toBe(Number(vaultBefore.balances.CAD) - 2000);
});

test("closing writes the counted figure back, and refuses to guess one", async ({ page }) => {
  await signInAtDesk(page);
  const book = ledger(page);
  await openCashDrawer(page);

  const before = await book.till();
  const currencies = Object.keys(before);
  expect(currencies.length).toBeGreaterThan(1); // the bug needed more than one

  /* Count every ledger currency but ONE, and deliberately count it short so
     a real variance exists. The close must stay blocked: the uncounted
     currency has no figure, and substituting one overwrites real cash. */
  const [firstCcy, ...rest] = currencies;
  await page.locator(`button:has-text("${firstCcy}")`).first().click();
  await page.getByRole("button", { name: /Enter total/i }).first().click();
  const short = Number(before[firstCcy!]) - 5;
  await page.locator('input[placeholder="0.00"]').first().fill(String(short));
  await saveDrawerCount(page);

  await clickDrawerTab(page, /Count & close/i);
  const closeButton = page.getByRole("button", { name: "Close the day", exact: true }).first();
  await expect(closeButton).toBeDisabled();
  await expect(page.getByText(/Count the drawer before closing\. Your count becomes the new till balance\.|Count all \d+ drawers before closing\. Your count becomes the new till balance\./)).toBeVisible();

  // now count the rest honestly, and close
  await clickDrawerTab(page, /Cash drawer/i);
  for (const ccy of rest) {
    await page.locator(`button:has-text("${ccy}")`).first().click();
    await page.getByRole("button", { name: /Enter total/i }).first().click();
    await page.locator('input[placeholder="0.00"]').first().fill(String(Number(before[ccy]!)));
  }
  await saveDrawerCount(page);
  await clickDrawerTab(page, /Count & close/i);
  await page.getByRole("button", { name: "Close the day", exact: true }).first().click();
  await page.getByRole("button", { name: "Close the day", exact: true }).last().click();

  await expect
    .poll(async () => (await book.session())?.status, { timeout: 20_000 })
    .toBe("closed");

  const closed = await book.session();
  expect(closed?.businessDate).toBeTruthy();
  const banner = await page.locator(".till-closedbanner").innerText();
  expect(banner).toContain(`trading day ${deskDay(closed.businessDate)}`);
  /* The closed banner names the trading day as Oct 12, never 2026-10-12. */
  expect(banner).not.toMatch(ISO_DATE);

  /* THE ASSERTION THIS FILE EXISTS FOR. Every currency holds what was
     counted — the short one is short by exactly five, and the others are
     untouched. Nothing was zeroed, and nothing was invented. */
  const after = await book.till();
  expect(Number(after[firstCcy!])).toBe(short);
  for (const ccy of rest) expect(Number(after[ccy]!)).toBe(Number(before[ccy]!));
});
