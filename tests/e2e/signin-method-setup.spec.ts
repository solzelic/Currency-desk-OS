/* Runtime Settings controls, with explicit API responses. These tests cover
   UI wiring and cancellation, not a real identity-provider authentication.
   The window casts below address the shipped, untyped React/IIFE globals. */
import { test, expect } from "./fixtures";

async function openSettings(page: import("@playwright/test").Page, connected = false, owner = false, passkey = false, totp = false) {
  await page.route("**/api/auth/methods", route => route.fulfill({ json: { methods: [
    { id: "password", name: "Email and password", connected: true },
    { id: "google", name: "Google", connected },
    { id: "microsoft", name: "Microsoft", connected: false },
    { id: "totp", name: "Authenticator app", connected: totp },
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
  await expect(page.getByRole("button", { name: "Confirming" })).toBeDisabled();
  await expect(page.locator("button.primary .spin")).toBeVisible();
  await expect(page.getByRole("form", { name: "Confirm sign-in method change" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await page.clock.fastForward(30_001);
  await expect(page.getByRole("alert")).toContainText("could not finish");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
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
  await expect(page.getByRole("button", { name: "Confirming" })).toBeDisabled();
  await expect(page.getByRole("form", { name: "Confirm sign-in method change" })).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "Confirming" }).evaluate((el: HTMLButtonElement) => { el.disabled = false; el.click(); });
  expect(confirmations).toBe(1);
  expect(removals).toBe(0);
  release();
  await expect(page.getByRole("alert")).toContainText("Add another way");
  expect(removals).toBe(1);
});

function contrast(fg: string, bg: string) {
  const parts = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = (c: string) => {
    const [r, g, b] = parts(c);
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  };
  const a = L(fg);
  const b = L(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("confirm and cancel are separate primary and secondary buttons", async ({ page }) => {
  await openSettings(page, false, true);
  const setup = page.getByRole("button", { name: "Set up authenticator", exact: true });
  await expect(setup).toHaveClass(/\bprimary\b/);
  await setup.click();
  const confirm = page.getByRole("button", { name: "Confirm and continue" });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(confirm).toHaveClass(/\bprimary\b/);
  await expect(cancel).toHaveClass(/\bsec\b/);
  const space = await confirm.evaluate((el) => {
    const row = el.parentElement!;
    const other = row.querySelector("button.sec")!;
    const a = el.getBoundingClientRect();
    const b = other.getBoundingClientRect();
    return { gap: parseFloat(getComputedStyle(row).columnGap || getComputedStyle(row).gap), apart: Math.max(b.left - a.right, b.top - a.bottom) };
  });
  expect(space.gap).toBeGreaterThanOrEqual(12);
  expect(space.apart).toBeGreaterThanOrEqual(8);
});

test("replace recovery codes is a primary button", async ({ page }) => {
  await openSettings(page, false, true, false, true);
  await expect(page.getByRole("button", { name: "Replace recovery codes" })).toHaveClass(/\bprimary\b/);
});

test("dark mode methods list keeps the card and text in contrast", async ({ page }) => {
  await openSettings(page);
  await page.evaluate(() => document.documentElement.setAttribute("data-cdtheme", "dark"));
  const colors = await page.locator(".methods").evaluate((card) => {
    const name = card.querySelector(".name") as HTMLElement;
    const meta = card.querySelector(".meta") as HTMLElement;
    return {
      bg: getComputedStyle(card).backgroundColor,
      name: getComputedStyle(name).color,
      meta: getComputedStyle(meta).color,
    };
  });
  expect(colors.bg.replace(/\s/g, "")).not.toBe("rgb(255,255,255)");
  expect(contrast(colors.name, colors.bg)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colors.meta, colors.bg)).toBeGreaterThanOrEqual(4.5);
});

test("a wrong factor is described on the field and visible on a phone", async ({ page }) => {
  let n = 0;
  await page.route("**/api/auth/stepup", route => {
    n += 1;
    if (n === 1) return route.fulfill({ status: 401, json: { error: "invalid_credentials" } });
    if (n === 2) return route.fulfill({ status: 403, json: { error: "factor_required" } });
    return route.fulfill({ status: 401, json: { error: "invalid_credentials" } });
  });
  await openSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-wrong-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  const passwordAlert = page.locator("#signin-password-error");
  await expect(passwordAlert).toContainText("could not confirm");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("aria-describedby", "signin-password-error");
  await expect(passwordAlert).toBeInViewport({ ratio: 1 });
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  const codeAlert = page.locator("#signin-totp-error");
  await expect(codeAlert).toContainText("could not confirm");
  await expect(page.getByLabel("Authenticator code")).toHaveAttribute("aria-describedby", "signin-totp-error");
  await expect(codeAlert).toBeInViewport({ ratio: 1 });
});

test("cancel while confirming aborts the request and clears the fields", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let confirmations = 0, starts = 0;
  await page.route("**/api/auth/stepup", async route => {
    confirmations++;
    await held;
    await route.fulfill({ json: { ok: true } }).catch(() => {});
  });
  await page.route("**/api/auth/sso/link/google/start", route => { starts++; return route.abort(); });
  await openSettings(page);
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect.poll(() => confirmations).toBe(1);
  const aborted = page.waitForEvent("requestfailed", req => req.url().endsWith("/api/auth/stepup"));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await aborted;
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  release();
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  expect(confirmations).toBe(1);
  expect(starts).toBe(0);
});

test("a timeout clears the authenticator code as well as the password", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/auth/stepup", route => {
    calls += 1;
    if (calls === 1) return route.fulfill({ status: 403, json: { error: "factor_required" } });
    return undefined;
  });
  await openSettings(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await page.getByLabel("Authenticator code").fill("123456");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.getByRole("button", { name: "Confirming" })).toBeDisabled();
  await page.clock.fastForward(30_001);
  await expect(page.getByRole("alert")).toContainText("could not finish");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Authenticator code")).toHaveValue("");
});

test("the setup key copies without spaces and a disabled finish says why", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));
  await page.route("**/api/auth/stepup", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/auth/mfa/enroll/start", route => route.fulfill({
    json: { ok: true, ticket: "synthetic-enrollment-ticket", manualSecret: "JBSWY3DPEHPK3PXP", backupCodes: ["test-recovery-code"] },
  }));
  await openSettings(page, false, true);
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.locator("code.setup-key span")).toHaveText(["JBSW", "Y3DP", "EHPK", "3PXP"]);
  expect(await page.locator("code.setup-key").textContent()).toBe("JBSWY3DPEHPK3PXP");
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();
  await expect(page.getByText("Enter the 6 digit code and tick that you saved your recovery codes.")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } },
    });
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { w.__clip.push(text); } },
    });
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __clip: string[] }).__clip)).toEqual(["JBSWY3DPEHPK3PXP"]);
  await page.getByLabel("New authenticator code").fill("123456");
  await expect(page.getByText("Tick that you saved your recovery codes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();
  await page.getByRole("button", { name: "Copy all" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clip: string[] }).__clip.at(-1))).toBe("test-recovery-code");
  await page.evaluate(() => {
    const w = window as unknown as { __blob: { created: string[]; revoked: string[]; text: string } };
    w.__blob = { created: [], revoked: [], text: "" };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      const url = create(blob);
      w.__blob.created.push(url);
      void blob.text().then((text) => { w.__blob.text = text; });
      return url;
    };
    URL.revokeObjectURL = (url: string) => { w.__blob.revoked.push(url); revoke(url); };
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("currencydesk-recovery-codes.txt");
  await expect(page.getByRole("button", { name: "Downloaded" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __blob: { text: string } }).__blob.text)).toContain("test-recovery-code");
  const saved = await page.evaluate(() => (window as unknown as { __blob: { created: string[]; revoked: string[]; text: string } }).__blob);
  expect(saved.created).toHaveLength(1);
  expect(saved.created[0]).toMatch(/^blob:/);
  expect(saved.revoked).toEqual(saved.created);
  expect(saved.text).toContain("Each code works once. Keep this file somewhere safe.");
  expect(saved.text).not.toMatch(/JBSWY3DPEHPK3PXP|@|synthetic-enrollment/);
  expect(await page.locator("a[download]").count()).toBe(0);
  await page.getByLabel("I saved these recovery codes").check();
  await expect(page.getByRole("button", { name: "Finish setup" })).toBeEnabled();
  await expect(page.getByText("Enter the 6 digit code and tick that you saved your recovery codes.")).toHaveCount(0);
  expect(logs.join("\n")).not.toMatch(/test-recovery-code|JBSWY3DPEHPK3PXP/);
});

async function focusedId(page: import("@playwright/test").Page) {
  return page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.id : ""));
}

test("a wrong password returns focus to the password field", async ({ page }) => {
  await page.route("**/api/auth/stepup", route => route.fulfill({ status: 401, json: { error: "invalid_credentials" } }));
  await openSettings(page);
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-wrong-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.locator("#signin-password-error")).toContainText("could not confirm");
  await expect.poll(() => focusedId(page)).toBe("signin-password");
});

test("a code-needed answer returns focus to the authenticator field", async ({ page }) => {
  await page.route("**/api/auth/stepup", route => route.fulfill({ status: 403, json: { error: "factor_required" } }));
  await openSettings(page);
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.locator("#signin-totp-error")).toContainText("Enter the code from your authenticator app");
  await expect.poll(() => focusedId(page)).toBe("signin-totp");
});

test("a wrong code returns focus to the authenticator field", async ({ page }) => {
  let n = 0;
  await page.route("**/api/auth/stepup", route => {
    n += 1;
    if (n === 1) return route.fulfill({ status: 403, json: { error: "factor_required" } });
    return route.fulfill({ status: 401, json: { error: "invalid_credentials" } });
  });
  await openSettings(page);
  await page.locator(".meth").filter({ hasText: "Google" }).getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(page.locator("#signin-totp-error")).toContainText("could not confirm");
  await expect.poll(() => focusedId(page)).toBe("signin-totp");
});
