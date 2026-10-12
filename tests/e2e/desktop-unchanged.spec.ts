/* One desktop picture for the whole desk.

   At 1280×800 the menu bar, the open window, and the dock of every app,
   and the sign-in screen, must match the PNG rendered from the main
   commit in tests/e2e/README.md. Animations and the caret are off.
   A changed rate, code, amount, fee, hold date, or cheque number fails
   the picture. Nothing rewrites the text after it renders.

   A pixel may differ by at most 1 in each channel (red, green, blue,
   alpha), and only as many pixels as AA_CAPS names for that picture.
   A picture with no cap is exact. A channel that moves by 2 or more
   fails even when the count is inside the cap. The break proof parses
   the sentence this file throws.

   The page clock is 2026-06-18T15:02:00.000Z. The menu bar is 24-hour,
   so it reads 15:02. The audit seed's 09:05 is the AM case: the desk
   paints it 9:05 AM, and 15:02 paints 3:02 PM. "2m 00s ago" is that
   same clock minus two minutes, stored as the rate board's publishedAt
   before the page scripts run.

   Cheques is one seeded cheque. The number, the hold date, the fee, and
   the customer id come from the constants below and from the stub, not
   from a string written onto the DOM after paint. */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { decodePng, diffRgba } = require("./tests/e2e/helpers/desktop-pixels.cjs") as {
  decodePng: (buffer: Buffer) => { width: number; height: number; data: Buffer };
  diffRgba: (actual: Buffer, expected: Buffer) => { diffPixels: number; maxDelta: number; overOne: number };
};

/* Measured against the pinned main render in the seam job. A non-zero
   value is the count of pixels that differed by exactly one level, and
   it is a hard cap. Leave a picture out when it matched exactly.
   Do not raise a cap to hide a layout or colour change. */
const AA_CAPS: Record<string, number> = {};

const DESKTOP = { width: 1280, height: 800 };
const AFTERNOON = Date.parse("2026-06-18T15:02:00.000Z");
const CHEQUE_NUMBER = "48120";
const HOLD_UNTIL = "2026-06-23";
const FEE = "5.00";
const RATE = 1.3914;
const CUSTOMER_ID = "cust_11111111-1111-4111-8111-111111111111";
const CHEQUE_ID = "chq_11111111-1111-4111-8111-111111111111";

const APPS: { id: string; title: RegExp }[] = [
  { id: "ledger", title: /Ledger/ },
  { id: "clients", title: /Clients/ },
  { id: "rates", title: /Rate Board/ },
  { id: "till", title: /Cash Drawer/ },
  { id: "compliance", title: /Compliance/ },
  { id: "reports", title: /Reports/ },
  { id: "settings", title: /Settings/ },
  { id: "pricing", title: /Pricing/ },
  { id: "transfers", title: /Transfers/ },
  { id: "cheques", title: /Cheques/ },
  { id: "vault", title: /Vault/ },
  { id: "audit", title: /Audit/ },
];

function seededCheque() {
  return {
    chequeId: CHEQUE_ID,
    ref: "CHQ-260618-48120",
    chequeNumber: CHEQUE_NUMBER,
    maker: "Northwood Property Management",
    draweeBank: "RBC Royal Bank",
    customerId: CUSTOMER_ID,
    customerName: "Northwood Property Management",
    chequeType: "business",
    typeLabel: "Business",
    currency: "USD",
    faceAmount: "1200.00",
    feeAmount: FEE,
    netAmount: "1195.00",
    endorsed: true,
    holdDays: 5,
    holdUntil: HOLD_UNTIL,
    receivedDate: "2026-06-18",
    status: "held",
    nsf: false,
    fraud: false,
    returnedReason: "",
    timeline: [{
      status: "held",
      at: "2026-06-18T15:02:00.000Z",
      actorId: "user:j.masri",
      note: "Cashed at the till",
    }],
    cashingTransactionId: null,
    cashingTransactionRef: null,
    createdBy: "user:j.masri",
  };
}

/* Date is replaced. Playwright's fake timers hand out ids from 1e12 and
   a later clear never finishes, so the timers stay real and only the
   clock is pinned. localStorage is written here, before the page
   scripts, and again on every navigation — the tests clear storage. */
async function pinDesk(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.addInitScript(({ ms, rate }) => {
    const RealDate = Date;
    function PinnedDate(this: Date, ...args: unknown[]) {
      if (!new.target) return new RealDate(ms).toString();
      if (args.length === 0) return new RealDate(ms);
      return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
    }
    PinnedDate.now = () => ms;
    PinnedDate.parse = RealDate.parse;
    PinnedDate.UTC = RealDate.UTC;
    PinnedDate.prototype = RealDate.prototype;
    (window as unknown as { Date: DateConstructor }).Date = PinnedDate as unknown as DateConstructor;
    try {
      localStorage.setItem("yorkfx_rates_v1", JSON.stringify({
        buyMargin: 0.015,
        sellMargin: 0.015,
        rows: { USD: { mid: rate, show: true } },
        publishedAt: new RealDate(ms - 120000).toISOString(),
        publishedBy: "J. Masri",
      }));
      localStorage.removeItem("yorkfx_rates_draft");
      localStorage.setItem("cdos_theme", "light");
    } catch (err) {
      /* about:blank has no storage. The app document does. */
    }
  }, { ms: AFTERNOON, rate: RATE });
  /* The converter would replace the seeded board with whatever the
     server last published, and a market snapshot would paint the
     provider's clock. Neither belongs in this picture. */
  await page.route("**/api/rates/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/rates/market") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ provider: null, mids: null }),
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/rates", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    if (new URL(route.request().url()).pathname !== "/api/rates") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ board: null, serverTime: AFTERNOON }),
    });
  });
}

/* The clients window reads /api/clients, which is not a ledger route.
   Other seam tests create contacts on this same desk before this
   picture runs. An empty list is the picture; a dirty database must
   not paint those contacts into it. */
async function pinClients(page: Page): Promise<void> {
  await page.route("**/api/clients**", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      await route.continue();
      return;
    }
    if (new URL(req.url()).pathname !== "/api/clients") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clients: [] }),
    });
  });
}

/* GET stubs for the book the pictures draw. POST keeps going, and the
   till roster is not stubbed, so signing in can still pick a drawer.
   A dirty database cannot paint a second cheque or a live transaction
   into these shots. */
async function pinBook(page: Page): Promise<void> {
  const summary = {
    homeCurrency: "CAD",
    tillId: "till",
    from: null,
    to: null,
    posted: 1,
    reversed: 0,
    volumeHome: "1200.00",
    unvaluedDeals: 0,
    feesHome: FEE,
    realizedPnlHome: null,
    costOfSaleHome: null,
    earningsHome: FEE,
    pricedDeals: 0,
    firstPostedAt: "2026-06-18T15:02:00.000Z",
    lastPostedAt: "2026-06-18T15:02:00.000Z",
    byActor: [],
    byCurrency: [],
  };
  const bodies: { test: (path: string) => boolean; body: unknown }[] = [
    { test: (path) => path === "/api/ledger/cheques", body: { cheques: [seededCheque()] } },
    { test: (path) => path === "/api/ledger/transactions", body: { transactions: [] } },
    { test: (path) => path === "/api/ledger/customers", body: { customers: [] } },
    { test: (path) => path.startsWith("/api/ledger/summary"), body: summary },
    { test: (path) => path === "/api/ledger/till-balances", body: { balances: { CAD: "1500.00", USD: "400.00" }, balanceGeneration: "1" } },
    {
      test: (path) => path === "/api/ledger/till-session",
      body: {
        session: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          sessionNumber: 1,
          businessDate: "2026-06-18",
          status: "open",
          openedBy: "user:j.masri",
          openedAt: "2026-06-18T13:00:00.000Z",
          closedBy: null,
          closedAt: null,
          closeNote: null,
        },
        latestCounts: {},
      },
    },
    { test: (path) => path === "/api/ledger/vault/movements", body: { movements: [] } },
    { test: (path) => path === "/api/ledger/vault", body: { branchId: null, tracked: false, balances: {}, branches: {} } },
    { test: (path) => path === "/api/ledger/report-filings", body: { filings: [] } },
    { test: (path) => path === "/api/ledger/obligations", body: { obligations: [] } },
    { test: (path) => path === "/api/ledger/position", body: { vaultTracked: false, currencies: [], positions: [] } },
  ];
  await page.route("**/api/ledger/**", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      await route.continue();
      return;
    }
    const path = new URL(req.url()).pathname;
    /* Sign-in still reads the real roster, then this picture keeps a
       single drawer. Other seam tests open a second till on the same
       branch, and the cash drawer then paints a banner the snapshot
       does not have. The id stays the server's, so the session header
       the desk sends is a real workspace. */
    if (path === "/api/ledger/till-roster") {
      const response = await route.fetch();
      const json = await response.json().catch(() => null);
      const list = json && Array.isArray(json.workspaces) ? json.workspaces : null;
      if (!list || list.length <= 1) {
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({
        response,
        json: { ...json, workspaces: [list[0]] },
      });
      return;
    }
    const hit = bodies.find((item) => item.test(path));
    if (!hit) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(hit.body),
    });
  });
}

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

async function fontsReady(page: Page): Promise<void> {
  const still = () => {
    const style = document.getElementById("shot-still") || document.createElement("style");
    style.id = "shot-still";
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    (document.head || document.documentElement).appendChild(style);
  };
  await page.evaluate(still);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  for (const frame of page.frames()) {
    await frame.evaluate(still).catch(() => {});
    await frame.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
    }).catch(() => {});
  }
}

async function openDesktopApp(page: Page, id: string, title: RegExp): Promise<Locator> {
  const dock = page.locator(`#appbar [data-app="${id}"]`);
  await dock.scrollIntoViewIfNeeded();
  await dock.click();
  const win = page.locator(".win.show.active");
  /* Main's windows do not carry data-app. The capture of main still
     takes the picture. This branch's windows do, and the pixel compare
     is what shows whether that attribute changed the desktop. */
  if (process.env.DESKTOP_BASELINE_FROM !== "main") {
    await expect(win).toHaveAttribute("data-app", id);
  }
  await expect(win.locator(".win-title")).toContainText(title);
  await expect(win).toHaveCSS("transform", "none");
  await expect(win).toHaveClass(/bar-hidden/);
  await dismissTour(page);
  if (id === "cheques") {
    await page.getByRole("button", { name: /Northwood Property Management/ }).click();
    await expect(page.getByText("Face value")).toBeVisible();
    await expect(page.getByText(CHEQUE_NUMBER).first()).toBeVisible();
    await expect(page.getByText(HOLD_UNTIL).first()).toBeVisible();
  }
  if (id === "rates") {
    const frame = page.frameLocator('iframe[title="Rate Board"]');
    if (process.env.DESKTOP_BASELINE_FROM === "main") {
      await expect(frame.locator("body")).toBeVisible();
    } else {
      await expect(frame.locator("#edSince")).toContainText("2m 00s");
    }
  }
  if (id === "audit") {
    await expect(win).toContainText("9:05 AM");
    await expect(win).toContainText("3:02 PM");
  }
  await fontsReady(page);
  return win;
}

function baselineFile(testInfo: TestInfo, name: string): string {
  const platformName = path.basename(testInfo.snapshotPath(name));
  if (process.env.DESKTOP_UPDATE_BASELINES === "1") {
    const dir = process.env.DESKTOP_SNAPSHOT_DIR;
    if (!dir || process.env.DESKTOP_BASELINE_FROM !== "main") {
      throw new Error("Refusing to write desktop pictures unless this run is rendering main.");
    }
    return path.join(dir, platformName);
  }
  if (process.env.DESKTOP_BASELINE_DIR) return path.join(process.env.DESKTOP_BASELINE_DIR, platformName);
  return testInfo.snapshotPath(name);
}

function remember(name: string, row: Record<string, unknown>): void {
  const file = path.join(process.cwd(), "test-results", "desktop-pixel-report.json");
  mkdirSync(path.dirname(file), { recursive: true });
  let prev: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { prev = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { prev = {}; }
  }
  prev[name] = row;
  writeFileSync(file, JSON.stringify(prev, null, 2));
}

/* The thrown sentence is parsed by scripts/prove-desktop-baseline-breaks.mjs.
   Keep the shape: "<name>: <n> pixels differ, max channel delta <n>, <n> pixels exceed 1 level, cap <n>." */
async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const shot = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
  const file = baselineFile(testInfo, name);
  if (process.env.DESKTOP_UPDATE_BASELINES === "1") {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, shot);
    remember(name, { wrote: file });
    return;
  }
  if (!existsSync(file)) throw new Error(`${name}: no baseline at ${file}`);
  const actual = decodePng(shot);
  const expected = decodePng(readFileSync(file));
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`${name}: size ${actual.width}x${actual.height} vs baseline ${expected.width}x${expected.height}`);
  }
  const diff = diffRgba(actual.data, expected.data);
  const cap = AA_CAPS[name] ?? 0;
  remember(name, { ...diff, cap, width: actual.width, height: actual.height });
  await testInfo.attach(`${name}-pixels`, {
    body: JSON.stringify({ ...diff, cap }),
    contentType: "application/json",
  });
  if (diff.maxDelta > 1 || diff.diffPixels > cap) {
    throw new Error(
      `${name}: ${diff.diffPixels} pixels differ, max channel delta ${diff.maxDelta}, ` +
      `${diff.overOne} pixels exceed 1 level, cap ${cap}. ` +
      (diff.maxDelta > 1
        ? "A channel moved by more than 1. That is a desktop change, not antialiasing."
        : "More pixels differ than the antialiasing cap."),
    );
  }
}

test("sign-in is unchanged at 1280", async ({ page }, testInfo) => {
  test.skip(process.env.DESKTOP_ONLY === "ledger", "the break proof shoots the ledger only");
  await page.setViewportSize(DESKTOP);
  await pinDesk(page);
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  const lock = page.locator("#lock");
  await expect(lock).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await fontsReady(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, testInfo, "sign-in-1280.png");
});

test("every desktop window is unchanged at 1280", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize(DESKTOP);
  await pinDesk(page);
  await pinBook(page);
  await pinClients(page);
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "j.masri");
  await dismissTour(page);
  await expect(page.locator("#phonebar")).toBeHidden();
  await expect(page.locator("#appbar")).toBeVisible();
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator(".mb-clock")).toContainText("15:02");

  const failures: string[] = [];
  for (const app of APPS) {
    if (process.env.DESKTOP_ONLY && process.env.DESKTOP_ONLY !== app.id) continue;
    await openDesktopApp(page, app.id, app.title);
    try {
      await shoot(page, testInfo, `${app.id}-1280.png`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (app.id === "cheques") {
      const scrim = page.locator("div.fixed.inset-0.flex.justify-end");
      await scrim.click({ position: { x: 16, y: 80 } });
      await expect(scrim).toHaveCount(0);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
});
