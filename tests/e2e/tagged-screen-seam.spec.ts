/* Opening Tagged used to throw before the window painted.
   The memo named deskFacts, which exists only inside Ledger, so the
   browser raised "deskFacts is not defined" and the follow-up list
   never appeared. This drives the dock and reads the screen. */
import { test, expect, signInAtDesk } from "./fixtures";

test("the Tagged screen opens", async ({ page }) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") crashes.push(msg.text());
  });

  await signInAtDesk(page);
  const dock = page.locator('[data-app="tagged"]');
  await dock.scrollIntoViewIfNeeded();
  await dock.click();

  await expect(page.getByText("Tagged transactions", { exact: true })).toBeVisible();
  expect(crashes.join("\n")).not.toMatch(/deskFacts is not defined/);
});
