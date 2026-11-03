/* #609 PR B: on a staging database, staging runtime and test shop, 0000 is
   everyone's stored PIN, so the staging door's people switch with it.
   This file makes its own database and starts a staging-shaped server on
   it (Chromium maps staging.currencydeskos.com to 127.0.0.1), then runs the
   real CLI: mark the database staging, then reset the PINs. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, landOnDesktop } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL: the reset needs a real database");
test.describe.configure({ mode: "serial" });

const PORT = 4188;
const HOST = "staging.currencydeskos.com";
const NAME = `staging_pin_e2e_${Date.now()}`;
const { Pool } = createRequire(path.join(process.cwd(), "server", "package.json"))("pg") as { Pool: new (c: { connectionString: string }) => any };
const dbUrl = () => { const u = new URL(process.env.SEAM_DATABASE_URL!); u.pathname = `/${NAME}`; return u.toString(); };
const ENV = () => ({ ...process.env, DATABASE_URL: dbUrl(), SEED_PASSWORD: "yorkville", RATES_SYNC: "off", NODE_ENV: "development", STAGING: "1", RENDER_EXTERNAL_HOSTNAME: HOST });

test.use({ baseURL: `http://${HOST}:${PORT}`, launchOptions: { args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] } });

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
  for (const command of ["mark-db", "reset-pins"]) {
    execFileSync("npx", ["tsx", "src/staging/cli.ts", command], { cwd: path.join(process.cwd(), "server"), env: ENV(), stdio: "ignore" });
  }
});
test.afterAll(async () => {
  server?.kill();
  await new Promise((r) => setTimeout(r, 1000));
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  await admin?.end();
});

async function enterAs(page: Page, role: string): Promise<void> {
  await page.goto("/app");
  await page.getByRole("button", { name: `Enter as ${role}` }).click();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

test("a staging door person switches to the owner with 0000", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enterAs(page, "Teller");
  await page.locator(".mb-acct:visible").first().click();
  const menu = page.locator(".acct-menu:visible");
  await expect(menu.getByText("Switch account", { exact: true })).toBeVisible();
  await menu.getByRole("button", { name: /J\. Masri/ }).click();
  const switched = page.waitForResponse((r) => r.url().endsWith("/api/auth/switch"));
  for (const digit of "0000") await page.getByRole("button", { name: digit, exact: true }).click();
  expect((await switched).status()).toBe(200);
  await expect(page.locator(".mb-acct:visible").first()).toContainText("J. Masri");
});
