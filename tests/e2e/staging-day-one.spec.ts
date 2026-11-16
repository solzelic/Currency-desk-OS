/* Staging "Start on Day 1", in the browser: the sign-in page's button makes
   a brand-new test shop and lands its owner on Day 1, over the real Home,
   signed in. This file makes its own database and starts a staging-shaped
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
