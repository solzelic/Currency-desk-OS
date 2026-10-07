/* The shortcut, the keys, and who is offered which screen.

   York FX has no ledger routes unless a seam database is configured,
   so this walk uses the desk itself: the palette, the header button,
   and the screens the dock would already show. A cashier does not
   get Till or Settings. An owner does.
*/
import { expect } from "@playwright/test";
import { signInAtDesk, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const skipped = {
      "j.masri": { status: "skipped", tour: "owner" },
      "a.singh": { status: "skipped", tour: "employee" },
      "m.costa": { status: "skipped", tour: "employee" },
    };
    localStorage.setItem("cdos_tour_v1", JSON.stringify(skipped));
  });
});

test("a cashier searches from the keyboard and cannot jump somewhere the dock hides", async ({ page }) => {
  await signInAtDesk(page, "m.costa");

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Quick search" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Settings/ })).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: /Till/ })).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: /Rate board/ })).toBeVisible();

  const first = await dialog.locator('[aria-selected="true"]').getAttribute("id");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.locator('[aria-selected="true"]')).not.toHaveAttribute("id", first || "");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.getByLabel("Search the desk").fill("rate");
  /* The empty box already lists Rate board, so visibility alone does not
     mean the query has landed. One row means the others have dropped. */
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option", { name: /Rate board/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".win").filter({ hasText: "Rate Board" }).first()).toBeVisible();
});

test("an owner is offered Settings and the till", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Quick search" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Settings/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /^Till/ })).toBeVisible();
});
