import { test, expect } from "./fixtures";

/* The compiled desk script is what /login loads. A minify that does
   not parse, or that throws while mounting the sign-in screen, fails
   here. This does not need a ledger: the lock screen is the boot. */
test("the compiled desk script boots the sign-in screen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  const response = await page.goto("/login");
  expect(response?.status()).toBe(200);

  const script = await page.request.get("/web/app/os.js");
  expect(script.status()).toBe(200);

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByPlaceholder("your-staff-id")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});
