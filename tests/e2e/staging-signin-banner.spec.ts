/* CD-117: real authentication responses and compiled browser callbacks.
   Each worker owns a staging-shaped server and disposable in-memory database.
   No response flags are injected. This tests sign-in presentation, not cash. */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, landOnDesktop } from "./fixtures";

const HOST = "staging.currencydeskos.com";
const BAR = "#cdos-staging-banner";
const serverRequire = createRequire(path.join(process.cwd(), "server/package.json"));
let server: ChildProcess | undefined;
let port: number;
let output = "";
test.use({ launchOptions: {
  ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, "--no-proxy-server"],
} });

test.beforeAll(async () => {
  server = spawn(process.execPath, [serverRequire.resolve("tsx/cli"), "tests/fixtures/staging-banner-server.ts"], {
    cwd: path.join(process.cwd(), "server"), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", PGLITE_MEMORY: "1", SEED_PASSWORD: "yorkville",
      STAGING: "1", RENDER_EXTERNAL_HOSTNAME: HOST, RATES_SYNC: "off",
      STATIC_DIR: "..", STATIC_INDEX: "CurrencyDesk OS.html", SITE_INDEX: "web/index.html",
    },
  });
  server.stdout!.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr!.on("data", (chunk) => { output += chunk.toString(); });
  port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Staging fixture did not start: ${output}`)), 30_000);
    server!.once("error", (error) => { clearTimeout(timeout); reject(error); });
    server!.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    server!.once("message", (message: { port: number }) => { clearTimeout(timeout); resolve(message.port); });
  });
});
test.afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => server!.kill("SIGKILL"), 5_000);
    server!.once("exit", () => { clearTimeout(timeout); resolve(); });
    if (server!.connected) server!.send("close"); else server!.kill();
  });
});

async function password(page: Page, staffId: string, host = HOST) {
  await page.goto(`http://${host}:${port}/app`);
  await page.getByPlaceholder("your-staff-id").fill(staffId);
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.locator('input[type="password"]').fill("yorkville");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/auth/login/start"));
  await page.getByRole("button", { name: staffId.includes("@") ? /Send my code/i : /^Sign in$/ }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  return result.json();
}

function observeRefreshes(page: Page) {
  const events = { navigations: 0, sessionReads: 0 };
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) events.navigations++; });
  page.on("request", (request) => { if (request.url().endsWith("/api/auth/me")) events.sessionReads++; });
  return events;
}

for (const host of [HOST, "127.0.0.1"]) {
  test(`password sign-in shows the correct first-screen label on ${host}`, async ({ page }) => {
    const events = observeRefreshes(page);
    const answer = await password(page, "j.masri", host);
    expect(answer.user.staging).toBe(host === HOST);
    await expect(page.getByRole("heading", { name: /Where are you working/i })).toBeVisible();
    if (host === HOST) await expect(page.locator(BAR)).toBeVisible();
    else await expect(page.locator(BAR)).toHaveCount(0);
    expect(events.navigations).toBe(1);
    expect(events.sessionReads).toBe(2); // initial resume and check, no post-sign-in refresh
  });
}

test("emailed-code verification labels the first signed-in screen", async ({ page }) => {
  const events = observeRefreshes(page);
  const start = await password(page, "banner@example.invalid");
  expect(start.needsCode).toBe(true);
  expect(start.user).not.toHaveProperty("staging");
  await expect.poll(() => output.match(/\[email simulated\] to=banner@example\.invalid :: (\d{6})/)?.[1]).toBeTruthy();
  const code = output.match(/\[email simulated\] to=banner@example\.invalid :: (\d{6})/)![1]!;
  const verified = page.waitForResponse((r) => r.url().endsWith("/api/auth/login/verify"));
  for (const digit of code) await page.getByRole("button", { name: digit, exact: true }).click();
  const response = await verified;
  expect(response.status()).toBe(200);
  expect((await response.json()).user.staging).toBe(true);
  await expect(page.getByRole("heading", { name: /Where are you working/i })).toBeVisible();
  await expect(page.locator(BAR)).toBeVisible();
  expect(events.navigations).toBe(1);
  expect(events.sessionReads).toBe(2);
});

test("forced password change retains the label on both screens", async ({ page }) => {
  const events = observeRefreshes(page);
  const answer = await password(page, "banner.force");
  expect(answer.user).toMatchObject({ staging: true, mustChangePassword: true });
  await expect(page.getByRole("heading", { name: "Set your own password" })).toBeVisible();
  await expect(page.locator(BAR)).toBeVisible();
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill("changed-banner-password");
  await fields.nth(1).fill("changed-banner-password");
  const changed = page.waitForResponse((r) => r.url().endsWith("/api/auth/change-password"));
  await page.getByRole("button", { name: /Save & continue/ }).click();
  expect((await changed).status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Where are you working/i })).toBeVisible();
  await expect(page.locator(BAR)).toBeVisible();
  expect(events.navigations).toBe(1);
  expect(events.sessionReads).toBe(2);
});

test("a PIN switch retains the runtime label without reloading", async ({ page }) => {
  const events = observeRefreshes(page);
  await password(page, "j.masri");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
  await page.locator(".mb-acct:visible").first().click();
  await page.locator(".acct-menu:visible").getByRole("button", { name: /M\. Costa/ }).click();
  const switched = page.waitForResponse((r) => r.url().endsWith("/api/auth/switch"));
  for (const digit of "4829") await page.getByRole("button", { name: digit, exact: true }).click();
  expect((await switched).status()).toBe(200);
  await expect(page.locator(".mb-acct:visible").first()).toContainText("M. Costa");
  await expect(page.locator(BAR)).toBeVisible();
  expect(events.navigations).toBe(1);
});
