/* With the sign-in flags unset, /login is the desk people already have.
   No passkey, Google, or Microsoft control, and no new request. */
import { test, expect } from "./fixtures";

test("flags off keeps today's sign-in and makes no new request", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("127.0.0.1") && !url.includes("localhost")) return;
    seen.push(new URL(url).pathname);
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/login");
  await expect(page.getByPlaceholder("your-staff-id")).toBeVisible();
  await expect(page.getByRole("button", { name: /passkey|google|microsoft/i })).toHaveCount(0);
  await expect(page.getByText("Continue with email")).toHaveCount(0);
  const joined = seen.join(" ");
  expect(joined).not.toContain("design-preview");
  expect(joined).not.toMatch(/webauthn|passkey|accounts\.google|login\.microsoft/i);
  await page.getByPlaceholder("your-staff-id").fill("flags-off@example.com");
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.locator('input[type="password"]')).toBeVisible();
});

test("the sign-in preview renders a state without an auth call", async ({ page }) => {
  const auth: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/auth") || req.url().includes("/api/staging")) auth.push(req.url());
  });
  await page.goto("/design-preview/signin/b?d=1280&motion=still");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.getByText("Waiting for your device")).toBeVisible();
  expect(auth).toEqual([]);
});

test("sign-in preview h does not show a password-rule placeholder", async ({ page }) => {
  await page.goto("/design-preview/signin/h?d=1280&motion=still");
  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();
  await expect(page.getByText("Password rule pending", { exact: false })).toHaveCount(0);
  await expect(page.getByText("password rule is not decided", { exact: false })).toHaveCount(0);
});
