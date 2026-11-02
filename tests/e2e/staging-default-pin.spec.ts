/* A staging test shop confirms with 0000 until the person picks their own.
   The seam server is 127.0.0.1, which isStagingRuntime refuses, so this file
   starts a staging-shaped server and Chromium maps staging.currencydeskos.com
   to it. The shop comes from /api/staging/fresh-shop and the real sign-up
   check, so the server is what makes it a test shop. */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, landOnDesktop } from "./fixtures";

const PORT = 4186;
const HOST = "staging.currencydeskos.com";
const ORIGIN = `http://${HOST}:${PORT}`;
const NEW_PASSWORD = "Fresh-shop-2026";

test.use({ baseURL: ORIGIN, launchOptions: { args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] } });
test.describe.configure({ mode: "serial" });

let server: ChildProcess | null = null;

test.beforeAll(async () => {
  server = spawn("npx", ["tsx", "src/seam-server.ts"], {
    cwd: path.join(process.cwd(), "server"),
    stdio: "ignore",
    env: {
      ...process.env,
      PORT: String(PORT), STATIC_DIR: "..", STATIC_INDEX: "CurrencyDesk OS.html", SITE_INDEX: "web/index.html",
      DATABASE_URL: "", PGLITE_MEMORY: "1", SEED_PASSWORD: "yorkville", RATES_SYNC: "off", NODE_ENV: "development",
      STAGING: "1", RENDER_EXTERNAL_HOSTNAME: HOST, STAGING_DEFAULT_PIN: "1",
    },
  });
  for (let i = 0; i < 240; i++) {
    const up = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok, () => false);
    if (up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the staging-shaped server did not start");
});
test.afterAll(() => { server?.kill(); });

async function freshShop(page: Page): Promise<void> {
  await page.goto("/app");
  const made = await page.evaluate(async (newPassword) => {
    const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const shop = await post("/api/staging/fresh-shop", {});
    if (shop.status !== 201) return `fresh-shop ${shop.status}`;
    const { email, code, password } = await shop.json();
    const verified = await post("/api/signup/verify", { email, code });
    if (verified.status !== 201) return `verify ${verified.status} ${await verified.text()}`;
    const changed = await post("/api/auth/change-password", { currentPassword: password, newPassword });
    return changed.ok ? "ok" : `change-password ${changed.status}`;
  }, NEW_PASSWORD);
  expect(made).toBe("ok");
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function promptAndType(page: Page, pin: string): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { React: any; ReactDOM: any; CDOS: { PinPrompt: unknown }; pinResult?: string; pinRoot?: { unmount(): void } };
    w.pinResult = "";
    const host = document.createElement("div");
    host.id = "pin-test-host";
    document.body.appendChild(host);
    w.pinRoot = w.ReactDOM.createRoot(host);
    w.pinRoot!.render(w.React.createElement(w.CDOS.PinPrompt, {
      title: "Confirm it’s you", sub: "Enter your PIN", name: "Staging owner",
      onOk: () => { w.pinResult = "ok"; }, onCancel: () => { w.pinResult = "cancel"; },
    }));
  });
  await expect(page.getByText("PIN required")).toBeVisible();
  for (const digit of pin) await page.keyboard.press(digit);
}

test("a fresh staging shop confirms with 0000, and after choosing 4826 both work and a wrong one does not", async ({ page }) => {
  await freshShop(page);

  const verified = page.waitForResponse((r) => r.url().endsWith("/api/staff/pin/verify"));
  await promptAndType(page, "0000");
  expect((await verified).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => (window as unknown as { pinResult?: string }).pinResult)).toBe("ok");
  await page.evaluate(() => (window as unknown as { pinRoot: { unmount(): void } }).pinRoot.unmount());
  await expect(page.getByText("PIN required")).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("settings"));
  const settings = page.locator(".win.show.active");
  await settings.getByRole("button", { name: /Staging owner/ }).first().click();
  await expect(page.getByText("Staging PIN 0000. Change it any time.")).toBeVisible();
  await page.getByRole("button", { name: "Change PIN" }).click();
  await expect(page.locator("[data-default-pin]")).toHaveText("Staging PIN 0000. Change it any time.");
  const fields = page.locator('input[placeholder="••••"]');
  await expect(fields).toHaveCount(2);
  await fields.nth(0).fill("4826");
  await fields.nth(1).fill("4826");
  await page.getByRole("button", { name: /Save PIN/ }).click();
  await expect(page.getByText("PIN updated")).toBeVisible();
  await expect(page.getByText("Staging PIN 0000. Change it any time.")).toHaveCount(0);

  for (const [pin, status] of [["0000", 200], ["4826", 200], ["1357", 401]] as const) {
    const answered = page.waitForResponse((r) => r.url().endsWith("/api/staff/pin/verify"));
    await promptAndType(page, pin);
    expect((await answered).status(), pin).toBe(status);
    const result = () => page.evaluate(() => (window as unknown as { pinResult?: string }).pinResult);
    if (status === 200) await expect.poll(result).toBe("ok");
    else { await expect(page.getByText("Incorrect PIN")).toBeVisible(); expect(await result()).toBe(""); }
    await page.evaluate(() => (window as unknown as { pinRoot: { unmount(): void } }).pinRoot.unmount());
  }
});
