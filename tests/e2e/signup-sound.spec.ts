import { expect, test } from "@playwright/test";
type SoundWindow = Window & { __cdOnb: { comp: { _ac?: AudioContext; _toneNow: (kind: string) => void } }; __soundEvidence: string[] };

test("sound wakes on press, responds once on release, and the account mute is keyboard reachable", async ({ page }) => {
  await page.goto("/onboarding");
  await page.waitForFunction(() => !!(window as SoundWindow).__cdOnb?.comp);
  expect(await page.evaluate(() => !!(window as SoundWindow).__cdOnb.comp._ac)).toBe(false);
  await page.evaluate(() => {
    const c = (window as SoundWindow).__cdOnb.comp;
    (window as SoundWindow).__soundEvidence = [];
    // Retain the real browser AudioContext wake/resume and event dispatch;
    // observe tone scheduling without sending noise to the reviewer's speakers.
    c._toneNow = (kind: string) => (window as SoundWindow).__soundEvidence.push(kind);
  });
  const start = page.getByRole("button", { name: /^Start/ });
  await start.click({ trial: true });
  const box = await start.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  expect(await page.evaluate(() => (window as SoundWindow).__soundEvidence)).toEqual([]);
  expect(await page.evaluate(() => !!(window as SoundWindow).__cdOnb.comp._ac)).toBe(true);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as SoundWindow).__soundEvidence.length)).toBe(1);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as SoundWindow).__soundEvidence.length)).toBe(1);

  const account = page.locator("[data-signup-account] summary");
  await account.focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const sound = page.getByRole("button", { name: "Sound on" });
  await expect(sound).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Sound off" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape"); await expect(account).toBeFocused();
  expect(await page.locator("[data-signup-account]").getAttribute("open")).toBeNull();
  await page.reload();
  await account.click();
  await expect(page.getByRole("button", { name: "Sound off" })).toBeVisible();
  expect(await page.evaluate(() => !!(window as SoundWindow).__cdOnb.comp._ac)).toBe(false);
  await page.setViewportSize({ width: 360, height: 740 });
  const target = await page.getByRole("button", { name: "Sound off" }).boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ animations: "disabled", path: test.info().outputPath("sound-menu-phone.png") });
});
