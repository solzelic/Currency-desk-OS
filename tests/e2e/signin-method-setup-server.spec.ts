/* Real HTTP + disposable PGlite: owner setup from the shipped Settings component.
   This server owns an ephemeral port and no shared or external database.
   Provider flags on this child do not affect the default flags-off browser gate. */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "./fixtures";

const serverRequire = createRequire(path.resolve("server/package.json"));
const { TOTP } = serverRequire("otpauth"); // The server's already-installed OTP implementation, test input only.
let child: ChildProcess | undefined;
let origin = "";

test.beforeAll(async () => {
  child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/seam-server.ts"], {
    cwd: path.resolve("server"), stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, NODE_ENV: "development", PORT: "0", HOST: "127.0.0.1",
      DATABASE_URL: "", LEDGER_DATABASE_URL: "", PGLITE_MEMORY: "1",
      STATIC_DIR: "..", STATIC_INDEX: "CurrencyDesk OS.html", SITE_INDEX: "web/index.html",
      SEED_PASSWORD: "synthetic-setup-password", SIGNIN_GOOGLE: "1", SIGNIN_MICROSOFT: "0", SIGNIN_PASSKEY: "0",
      RATES_SYNC: "off", SCREENING_FETCH: "off", STAGING: "0", RENDER: "", RENDER_SERVICE_ID: "", RENDER_EXTERNAL_HOSTNAME: "",
    },
  });
  // Drain both pipes. Request bodies and enrollment secrets are not captured.
  child.stderr?.resume();
  origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("isolated auth server did not start")), 30_000);
    let output = "";
    child?.stdout?.on("data", chunk => {
      output = (output + String(chunk)).slice(-8192);
      const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child?.once("error", error => { clearTimeout(timeout); reject(error); });
    child?.once("exit", () => { clearTimeout(timeout); reject(new Error("isolated auth server exited")); });
  });
});

test.afterAll(async () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child?.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const deadline = setTimeout(() => child?.kill("SIGKILL"), 5_000);
  await stopped;
  clearTimeout(deadline);
});

test("owner can enroll an authenticator through Settings and prove it to the server", async ({ page }) => {
  const login = await page.request.post(origin + "/api/auth/login", {
    data: { staffId: "j.masri", password: "synthetic-setup-password" },
  });
  expect(login.status()).toBe(200);
  const me = await page.request.get(origin + "/api/auth/me");
  expect(me.status()).toBe(200);
  const identity = await me.json();
  expect(identity.user.role).toBe("administrator");
  await page.goto(origin + "/app");
  await page.waitForFunction(() => !!(window as any).CDOS?.SignInMethodsSettings); // Shipped untyped window bundle.
  await page.evaluate(() => {
    const w = window as any; // Shipped React global; this test mounts the production Settings component.
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    w.ReactDOM.createRoot(host).render(w.React.createElement(w.CDOS.SignInMethodsSettings, { owner: true }));
  });
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("synthetic-setup-password");
  await page.getByRole("button", { name: "Confirm and continue" }).click();
  const form = page.getByRole("form", { name: "Authenticator setup" });
  await expect(form).toBeVisible();
  const secret = (await form.locator("code.setup-key").innerText()).replace(/\s/g, "");
  const totp = new TOTP({ secret, digits: 6, period: 30, algorithm: "SHA1" });
  await page.getByLabel("New authenticator code").fill(totp.generate());
  await page.getByLabel("I saved these recovery codes").check();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("status")).toContainText("Authenticator connected");
  const methods = await page.request.get(origin + "/api/auth/methods");
  expect((await methods.json()).methods).toContainEqual({ id: "totp", name: "Authenticator app", connected: true });
  // Password-only confirmation is now refused; setup really changed server authority.
  const weak = await page.request.post(origin + "/api/auth/stepup", { data: { password: "synthetic-setup-password" } });
  expect(weak.status()).toBe(403);
  expect((await weak.json()).error).toBe("factor_required");
  await page.reload();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
});
