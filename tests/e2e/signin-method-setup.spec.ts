/* Runtime Settings controls, with explicit API responses. These tests cover
   UI wiring and cancellation, not a real identity-provider authentication.
   The window casts below address the shipped, untyped React/IIFE globals. */
import { test, expect } from "./fixtures";

async function openSettings(page: import("@playwright/test").Page, connected = false, owner = false, passkey = false) {
  await page.route("**/api/auth/methods", route => route.fulfill({ json: { methods: [
    { id: "password", name: "Email and password", connected: true },
    { id: "google", name: "Google", connected },
    { id: "microsoft", name: "Microsoft", connected: false },
    { id: "totp", name: "Authenticator app", connected: false },
    { id: "passkey", name: "Passkey", connected: passkey },
  ] } }));
  await page.goto("/login");
  await page.waitForFunction(() => !!(window as any).CDOS?.SignInMethodsSettings);
  await page.evaluate((owner) => {
    const w = window as any;
    w.CDOS.signInFlags = { google: true, microsoft: true, passkey: false };
    const host = document.createElement("div");
    host.id = "method-settings-test";
    document.body.replaceChildren(host);
    w.__methodSettingsRoot = w.ReactDOM.createRoot(host);
    w.__methodSettingsRoot.render(w.React.createElement(w.CDOS.SignInMethodsSettings, { owner }));
  }, owner);
}

test("Connect reconfirms identity before leaving for the provider", async ({ page }) => {
  const calls: { password: string; totp?: string }[] = [];
  await page.route("**/api/auth/stepup", async route => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: calls.length === 1 ? 401 : 200, json: calls.length === 1 ? { error: "invalid_credentials" } : { ok: true } });
  });
  await page.route("**/api/auth/sso/link/google/start", route => route.fulfill({ contentType: "text/html", body: "Provider start reached" }));
  await openSettings(page);
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByLabel("Password", { exact: true }).fill("synthetic-wrong-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("could not confirm");
  expect(page.url()).toContain("/login");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-correct-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.getByText("Provider start reached")).toBeVisible();
  expect(calls).toEqual([{ password: "synthetic-wrong-password" }, { password: "synthetic-correct-password" }]);
});

test("an existing passkey can confirm a method change without a password", async ({ page }) => {
  let passwordCalls = 0;
  await page.route("**/api/auth/stepup", route => { passwordCalls++; return route.abort(); });
  await page.route("**/api/auth/stepup/passkey/options", route => route.fulfill({ json: {
    challenge: "c3ludGhldGljLWNoYWxsZW5nZQ", rpId: "127.0.0.1", userVerification: "required", allowCredentials: [],
  } }));
  await page.route("**/api/auth/stepup/passkey/verify", route => {
    expect(route.request().postDataJSON()).toEqual({ id: "synthetic-credential", type: "public-key" });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/auth/sso/link/google/start", route => route.fulfill({ contentType: "text/html", body: "Provider start reached" }));
  await openSettings(page, false, false, true);
  await page.evaluate(() => {
    // Stub only the physical authenticator; parsing uses the browser's WebAuthn API.
    Object.defineProperty(navigator.credentials, "get", { value: async (options: CredentialRequestOptions) => {
      const challenge = options.publicKey?.challenge;
      if (options.publicKey?.userVerification !== "required" || !(challenge instanceof ArrayBuffer || ArrayBuffer.isView(challenge))) throw new Error("bad options");
      return { toJSON: () => ({ id: "synthetic-credential", type: "public-key" }) };
    } });
  });
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("button", { name: "Confirm with passkey" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page.getByText("Provider start reached")).toBeVisible();
  expect(passwordCalls).toBe(0);
});

test("a stalled confirmation times out without navigating or starting setup", async ({ page }) => {
  let setupCalls = 0;
  await page.route("**/api/auth/stepup", () => {});
  await page.route("**/api/auth/mfa/enroll/start", route => { setupCalls++; return route.abort(); });
  await openSettings(page, false, true);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.clock.fastForward(30_001);
  await expect(page.getByRole("alert")).toContainText("could not finish");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  expect(setupCalls).toBe(0);
});

test("leaving Settings aborts confirmation and a late success cannot start enrollment", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false, setupCalls = 0;
  await page.route("**/api/auth/stepup", async route => {
    started = true;
    await held;
    await route.fulfill({ json: { ok: true } }).catch(() => {}); // Browser cancellation may already have closed this request.
  });
  await page.route("**/api/auth/mfa/enroll/start", route => { setupCalls++; return route.abort(); });
  await openSettings(page, false, true);
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect.poll(() => started).toBe(true);
  const aborted = page.waitForEvent("requestfailed", req => req.url().endsWith("/api/auth/stepup"));
  await page.evaluate(() => (window as any).__methodSettingsRoot.unmount()); // Test-owned React root only.
  await aborted;
  release();
  expect(setupCalls).toBe(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
});

test("owner authenticator setup confirms a code and acknowledges recovery codes before closing", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/auth/stepup", route => { calls.push("stepup"); return route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/auth/mfa/enroll/start", route => {
    calls.push("start");
    return route.fulfill({ json: { ok: true, ticket: "synthetic-enrollment-ticket", manualSecret: "JBSWY3DPEHPK3PXP", backupCodes: ["test-recovery-code"] } });
  });
  await page.route("**/api/auth/mfa/enroll/confirm", route => {
    calls.push("confirm");
    expect(route.request().postDataJSON()).toEqual({ ticket: "synthetic-enrollment-ticket", code: "123456" });
    return route.fulfill({ json: { ok: true } });
  });
  await openSettings(page, false, true);
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.getByText("JBSWY3DPEHPK3PXP", { exact: true })).toBeVisible();
  await expect(page.getByText("test-recovery-code", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("form", { name: "Authenticator setup" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("owner-setup-phone.png"), fullPage: true });
  await page.getByLabel("New authenticator code").fill("123456");
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();
  await page.getByLabel("I saved these recovery codes").check();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("status")).toContainText("Authenticator connected");
  await expect(page.getByText("JBSWY3DPEHPK3PXP", { exact: true })).toHaveCount(0);
  await expect(page.getByText("test-recovery-code", { exact: true })).toHaveCount(0);
  expect(calls).toEqual(["stepup", "start", "confirm"]);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toMatch(/test-recovery-code|JBSWY3DPEHPK3PXP|synthetic-enrollment-ticket/);
});

test("a required authenticator is collected and cancellation clears secrets", async ({ page }) => {
  const calls: { password: string; totp?: string }[] = [];
  await page.route("**/api/auth/stepup", route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ status: 403, json: { error: "factor_required" } });
  });
  await openSettings(page);
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.getByLabel("Authenticator code")).toBeVisible();
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toEqual({ password: "synthetic-password", totp: "123456" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Authenticator code")).toHaveCount(0);
});

test("a pending reconfirmation cannot submit twice or remove a method early", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let confirmations = 0, removals = 0;
  await page.route("**/api/auth/stepup", async route => { confirmations++; await held; await route.fulfill({ json: { ok: true } }); });
  await page.route("**/api/auth/sso/google/unlink", route => { removals++; return route.fulfill({ status: 409, json: { error: "last_method" } }); });
  await openSettings(page, true);
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Remove" }).click();
  expect(removals).toBe(0);
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect.poll(() => confirmations).toBe(1);
  await expect(page.getByRole("button", { name: "Confirm and continue" })).toBeDisabled();
  await page.getByRole("button", { name: "Confirm and continue" }).evaluate((el: HTMLButtonElement) => { el.disabled = false; el.click(); });
  expect(confirmations).toBe(1);
  expect(removals).toBe(0);
  release();
  await expect(page.getByRole("alert")).toContainText("Add another way");
  expect(removals).toBe(1);
});
