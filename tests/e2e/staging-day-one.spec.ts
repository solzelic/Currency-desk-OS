/* Staging "Start on Day 1", in the browser: the sign-in page's button makes
   a brand-new test shop and lands its owner on Day 1, over the real Home,
   signed in. The press goes straight to Day 1's welcome, which says the shop
   is opening until it has. This file makes its own database and starts a staging-shaped
   server on it (Chromium maps staging.currencydeskos.com to 127.0.0.1),
   then runs the real CLI to mark the database staging, which the door needs. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, landOnDesktop } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL: the staging marker needs a real database");
test.describe.configure({ mode: "serial" });

const PORT = 4189;
const HOST = "staging.currencydeskos.com";
const BASE = `http://${HOST}:${PORT}`;
const NAME = `staging_day_one_e2e_${Date.now()}`;
const { Pool } = createRequire(path.join(process.cwd(), "server", "package.json"))("pg") as { Pool: new (c: { connectionString: string }) => any };
const dbUrl = () => { const u = new URL(process.env.SEAM_DATABASE_URL!); u.pathname = `/${NAME}`; return u.toString(); };
const ENV = () => ({ ...process.env, DATABASE_URL: dbUrl(), SEED_PASSWORD: "yorkville", RATES_SYNC: "off", SCREENING_FETCH: "off", NODE_ENV: "development", STAGING: "1", RENDER_EXTERNAL_HOSTNAME: HOST });

test.use({ baseURL: BASE, launchOptions: { args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] } });

type DayOne = { ok: true; cdId: string; operatingName: string; signIn: { email: string; password: string; pin: string } };

let server: ChildProcess | null = null;
let admin: any;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  admin = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  await admin.query(`CREATE DATABASE ${NAME}`);
  server = spawn("npx", ["tsx", "src/seam-server.ts"], {
    cwd: path.join(process.cwd(), "server"), stdio: "ignore",
    env: { ...ENV(), PORT: String(PORT), STATIC_DIR: "..", STATIC_INDEX: "CurrencyDesk OS.html", SITE_INDEX: "web/index.html" },
  });
  for (let i = 0; i < 240; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  execFileSync("npx", ["tsx", "src/staging/cli.ts", "mark-db"], { cwd: path.join(process.cwd(), "server"), env: ENV(), stdio: "ignore" });
});
test.afterAll(async () => {
  server?.kill();
  await new Promise((r) => setTimeout(r, 1000));
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  await admin?.end();
});

/* Asked from inside the page: the host mapping is Chromium's, and the cookies are the page's. */
async function inPage(page: Page, url: string): Promise<{ status: number; body: any }> {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "same-origin" });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, url);
}

/** The sign-in page, its Start on Day 1 button, and the server's one answer. */
async function startOnDayOne(page: Page, shot?: string): Promise<DayOne> {
  await page.goto("/app");
  const button = page.getByRole("button", { name: /Start on Day 1/ });
  await expect(button).toBeVisible();
  await expect(page.getByRole("button", { name: /Start a fresh shop/ })).toBeVisible();
  if (shot) await page.screenshot({ path: test.info().outputPath(shot), animations: "disabled" });
  const created = page.waitForResponse((r) => r.url().endsWith("/api/staging/day-one"), { timeout: 60_000 });
  await button.click();
  const res = await created;
  expect(res.status()).toBe(201);
  return (await res.json()) as DayOne;
}

async function onDayOne(page: Page, body: DayOne) {
  await expect(page).toHaveURL(`${BASE}/onboarding`);
  const line = page.locator("[data-staging-day-one]");
  await expect(line).toBeVisible({ timeout: 60_000 });
  await expect(line).toContainText(`Counter PIN ${body.signIn.pin}`);
  await expect(line).toContainText(body.signIn.email);
  await expect(line).toContainText(body.signIn.password);
  await expect(page.locator("[data-staging-day-one]")).toHaveCount(1);
  const frame = page.frameLocator("iframe[data-real-home]");
  await expect(frame.locator("[data-signup-home]")).toHaveAttribute("data-signup-home", /^tnt-/, { timeout: 60_000 });
  await expect(page.getByText(`${body.operatingName} is open`, { exact: false }).first()).toBeVisible();
  return frame;
}

test("Start on Day 1 opens a new test shop on its first day, signed in as its owner", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const stripe: string[] = [];
  page.on("request", (r) => { if (/stripe\.com/.test(r.url())) stripe.push(r.url()); });
  const body = await startOnDayOne(page, "staging-signin-day-one-button.png");
  await onDayOne(page, body);
  await page.screenshot({ path: test.info().outputPath("staging-day-one.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-staging-day-one]")).toBeVisible();
  await page.locator("[data-staging-day-one]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("staging-day-one-phone.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(stripe).toEqual([]);

  /* the desk session is the new owner's, on a test shop */
  const me = await inPage(page, "/api/auth/me");
  expect(me.status).toBe(200);
  const user = me.body.user as { tenantId: string };
  const tenant = (await inPage(page, "/api/tenant")).body.tenant as { id: string; name?: string };
  expect(tenant.id).toBe(user.tenantId);
  expect(tenant.name).toBe(body.operatingName);

  /* Nothing secret in this browser's storage. The sign-up tab keeps nothing
     of the shop; the real Home's own settings cache (localStorage, as for
     every owner) holds the shop's settings, never the password or PIN. */
  const storage = await page.evaluate(() => {
    const read = (s: Storage) => { const all: Record<string, string> = {}; for (let k = 0; k < s.length; k++) { const key = s.key(k)!; all[key] = s.getItem(key) ?? ""; } return all; };
    return { session: read(sessionStorage), local: read(localStorage) };
  });
  const session = JSON.stringify(storage.session);
  for (const value of [body.signIn.password, body.signIn.email, body.cdId]) expect(session).not.toContain(value);
  expect(Object.keys(storage.session)).not.toContain("cdDayOne");
  expect(JSON.stringify(storage.local)).not.toContain(body.signIn.password);
  for (const s of [storage.session, storage.local]) expect(Object.values(s)).not.toContain(body.signIn.pin);

  /* a reload drops the one-time line and lands on the welcome; the desk session still opens the shop */
  await page.reload();
  await expect(page).toHaveURL(`${BASE}/onboarding`);
  await expect(page.locator("[data-staging-day-one]")).toHaveCount(0);
  await page.goto("/app");
  await landOnDesktop(page);
  expect((await inPage(page, "/api/auth/me")).body.user.tenantId).toBe(user.tenantId);
});

/* From the press: what the sign-up page ever drew, and whether the real Home
   was ever visible before it had drawn itself (the sign-in it starts on). */
async function watchDayOne(page: Page) {
  await page.addInitScript(() => {
    if (location.pathname !== "/onboarding") return;
    const seen = { standIn: [] as string[], screens: [] as string[], homeShownEarly: 0 };
    (window as unknown as { __dayOne: typeof seen }).__dayOne = seen;
    const mark = (name: string) => { if (seen.screens[seen.screens.length - 1] !== name) seen.screens.push(name); };
    const look = () => {
      const root = document.getElementById("dc-root");
      /* the prototype's stand-in shop and owner (SIGNUP-LOGIC section 13), the
         plan screen's landing, its sample desk ("Sample rates", drawn upper
         case by CSS) and the old hold. Each is really in the built page
         (tests/signup-staging-client.test.mjs checks), so "never" means never. */
      const text = root?.textContent ?? "";
      for (const s of ["York Currency Exchange", "Masri", "Daniel Osei", "yorkcurrency", "Your desk is set up", "Sample rates", "Opening a staging test shop"]) if (text.includes(s) && !seen.standIn.includes(s)) seen.standIn.push(s);
      /* every screen: a wizard screen by number, the plan screen by its payment
         panel, the prototype's own desk by its chrome, Day 1 by its desk */
      const screen = root?.querySelector("[data-signup-screen]")?.getAttribute("data-signup-screen");
      if (screen) mark(screen);
      if (root?.querySelector("[data-paymodal]")) mark("plan");
      if (root?.querySelector("[data-deskapps], [data-deskcrumb], [data-desklogo]")) mark("prototype-desk");
      if (root?.querySelector("[data-desk]")) mark("desk");
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    setInterval(() => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe[data-real-home]");
      if (!frame || Number(getComputedStyle(frame).opacity) === 0) return;
      if (!frame.contentDocument?.querySelector("[data-signup-home]")) seen.homeShownEarly++;
    }, 40);
  });
}
const watched = (page: Page) => page.evaluate(() => (window as unknown as { __dayOne: { standIn: string[]; screens: string[]; homeShownEarly: number } }).__dayOne);

test("the press goes straight to Day 1: its welcome says the shop is opening, Build my desk waits, nothing else can be pressed, and no stand-in, landing or sign-in shows", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await watchDayOne(page);
  /* the server's answer held 3 seconds, as a slow staging database would */
  await page.route("**/api/staging/day-one", async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await page.goto("/app");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/staging/day-one"), { timeout: 60_000 });
  await page.getByRole("button", { name: /Start on Day 1/ }).click();

  const build = page.locator("[data-build-my-desk]");
  await expect(build).toBeVisible();
  await expect(build).toBeDisabled();
  await expect(build).toHaveText("Opening your desk…");
  await expect(build).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Welcome to CurrencyDesk.")).toBeVisible();
  await expect(page.getByText("Signing up a new staging test shop and opening its desk.")).toBeVisible();
  await expect(page.locator("[data-staging-day-one-hold]")).toHaveCount(0);
  /* nothing is covered or made inert (the real Home's frame is always inert: it is a backdrop) */
  await expect(page.locator("#dc-root [inert]:not(iframe[data-real-home])")).toHaveCount(0);
  await expect(page.locator("[data-paymodal]")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("staging-day-one-opening.png"), animations: "disabled" });
  /* a click, Tab and Enter, and Escape change nothing */
  await page.mouse.click(640, 640);
  await build.click({ force: true });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(build).toBeDisabled();
  await expect(page.locator("[data-desk]")).toHaveCount(1);

  const res = await created;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as DayOne;
  /* the press is carried through to Day 1, not dropped */
  await onDayOne(page, body);
  await expect(build).toBeEnabled();
  await expect(build).toHaveText("Build my desk →");
  const seen = await watched(page);
  expect(seen.standIn).toEqual([]);
  /* Day 1 was the only screen the press ever drew */
  expect(seen.screens).toEqual(["desk"]);
  expect(seen.homeShownEarly).toBe(0);
});

test("an /open that takes a while keeps Day 1's welcome and says so there, then opens", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await watchDayOne(page);
  /* the first twelve /open calls answer "still opening", as a slow webhook would */
  let held = 0;
  await page.route("**/api/onboarding/*/open", async (route) => {
    if (held++ < 12) return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: false, opening: true }) });
    return route.continue();
  });
  const body = await startOnDayOne(page);
  await expect(page.getByText(`Opening ${body.operatingName}.`)).toBeVisible();
  /* the welcome's own sentence says it (a polite live region), and Build my desk stays busy */
  await expect(page.getByRole("status").filter({ hasText: "Still opening the desk. This can take a minute. Stay on this page." })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-build-my-desk]")).toBeDisabled();
  await expect(page.locator("[data-build-my-desk]")).toHaveAttribute("aria-busy", "true");
  await page.screenshot({ path: test.info().outputPath("staging-day-one-still-opening-phone.png"), animations: "disabled" });
  await onDayOne(page, body);
  await expect(page.locator("[data-build-my-desk]")).toBeEnabled();
  const seen = await watched(page);
  expect(seen.standIn).toEqual([]);
  expect(seen.screens).toEqual(["desk"]);
  expect(seen.homeShownEarly).toBe(0);
});

test("on a short phone, an /open that refuses keeps the reason and Check again on the welcome, reachable by scrolling, and Check again opens it", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await watchDayOne(page);
  /* the first /open fails as a server error would; the next goes through */
  let refused = 0;
  await page.route("**/api/onboarding/*/open", async (route) => {
    if (refused++ < 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable", detail: "The desk didn’t open just now." }) });
    return route.continue();
  });
  const body = await startOnDayOne(page);
  await expect(page.getByRole("status").filter({ hasText: "The desk didn’t open just now." })).toBeVisible({ timeout: 60_000 });
  const build = page.locator("[data-build-my-desk]");
  await expect(build).toBeDisabled();
  await expect(build).toHaveText("Desk not open yet");
  await expect(build).toHaveAttribute("aria-busy", "false");
  const check = page.getByRole("button", { name: "Check again" });
  /* measured once the card's entrance (a scale-in, then fade-ups) has settled */
  await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState === "finished"));
  /* reached the way a person would, with the wheel over the page, never scrollIntoView */
  await page.mouse.move(180, 320);
  for (let k = 0; k < 6; k++) await page.mouse.wheel(0, 400);
  await expect.poll(async () => { const b = await check.boundingBox(); return !!b && b.y >= 0 && b.y + b.height <= 640; }).toBe(true);
  const box = (await check.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: test.info().outputPath("staging-day-one-refused-short-phone.png"), animations: "disabled" });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await onDayOne(page, body);
  await expect(build).toBeEnabled();
  const seen = await watched(page);
  expect(seen.standIn).toEqual([]);
  expect(seen.screens).toEqual(["desk"]);
  expect(seen.homeShownEarly).toBe(0);
});

test("a second press, in another browser, is another shop, and Build my desk opens it", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL: BASE });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    const first = await startOnDayOne(page);
    await onDayOne(page, first);
    const firstTenant = (await inPage(page, "/api/auth/me")).body.user.tenantId as string;
    const other = await browser.newContext({ baseURL: BASE });
    try {
      const second = await other.newPage();
      await second.setViewportSize({ width: 1280, height: 800 });
      const next = await startOnDayOne(second);
      await onDayOne(second, next);
      expect(next.cdId).not.toBe(first.cdId);
      expect(next.signIn.email).not.toBe(first.signIn.email);
      const nextTenant = (await inPage(second, "/api/auth/me")).body.user.tenantId as string;
      expect(nextTenant).not.toBe(firstTenant);
    } finally {
      await other.close();
    }
    await page.getByRole("button", { name: /Build my desk/ }).click();
    await expect(page).toHaveURL(/\/app/);
    await landOnDesktop(page);
    expect((await inPage(page, "/api/auth/me")).body.user.tenantId).toBe(firstTenant);
  } finally {
    await context.close();
  }
});
