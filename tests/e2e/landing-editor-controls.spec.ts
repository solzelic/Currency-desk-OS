/* ============================================================
   A visitor's page carries no editor control (CD-135, GitHub #625).

   The public landing page and the York FX storefront draw their photos
   with <image-slot>, the design tool's element. Each slot carried a
   Replace and an Edit button in its shadow DOM, hidden only by opacity,
   for every visitor; a browser that did not apply the slot's styles
   showed them, which is what the usability tester saw. Now the buttons
   exist only while the design tool's runtime can write (window.omelette
   .writeFile), and a visitor's page has none at all, at any width.
   There is no server route behind them: writes go to the design tool's
   own file API, which a visitor's browser does not have.
   ============================================================ */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/* Every button inside every slot's shadow DOM, by text. */
const slotButtons = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll("image-slot")].map((slot) => ({
    id: slot.id,
    editable: slot.hasAttribute("data-editable"),
    buttons: slot.shadowRoot ? [...slot.shadowRoot.querySelectorAll("button")].map((b) => b.textContent?.trim()) : [],
  })),
);

for (const [name, width] of [["desktop", 1280], ["phone", 390]] as const) {
  test(`a signed-out visitor at ${name} width sees no Replace or Edit control on the landing page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator("image-slot").first()).toBeAttached({ timeout: 20_000 });
    const slots = await slotButtons(page);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.editable, slot.id).toBe(false);
      expect(slot.buttons, slot.id).toEqual([]);
    }
    expect(await page.getByRole("button", { name: /^(Replace|Edit)$/ }).count()).toBe(0);
  });
}

test("the York FX storefront's photos carry none either", async ({ page }) => {
  await page.goto("/YorkFX/YorkFX%20Homepage.html");
  await expect(page.locator("image-slot").first()).toBeAttached({ timeout: 20_000 });
  for (const slot of await slotButtons(page)) expect(slot.buttons, slot.id).toEqual([]);
});

test("the design tool still gets its controls: a host that can write sees Replace and Edit", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { omelette: { writeFile: () => Promise<void> } }).omelette = { writeFile: async () => {} };
  });
  await page.goto("/");
  await expect(page.locator("image-slot").first()).toBeAttached({ timeout: 20_000 });
  const slots = await slotButtons(page);
  expect(slots.length).toBeGreaterThan(0);
  for (const slot of slots) {
    expect(slot.editable, slot.id).toBe(true);
    expect(slot.buttons, slot.id).toEqual(["Replace", "Edit"]);
  }
});
