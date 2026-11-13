/* An older desk can still offer a PIN in its settings snapshot. The
   server drops it, keeps the rest of the save, and tells the bridge.
   The operator needs that answer before trying to switch accounts. */
import { test, expect, signInAtDesk } from "./fixtures";

let originalState: Record<string, unknown> | null = null;

test.afterEach(async ({ page }) => {
  if (!originalState) return;
  const current = await page.request.get("/api/tenant/state");
  expect(current.status()).toBe(200);
  const restored = await page.request.put("/api/tenant/state", {
    data: { state: originalState, version: (await current.json()).version },
  });
  expect(restored.status()).toBe(200);
  originalState = null;
});

for (const width of [1280, 390]) {
  test(`an ignored settings PIN points to Settings and saving continues at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await signInAtDesk(page, "j.masri");
    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible()) await skip.click();
    const original = await page.request.get("/api/tenant/state");
    expect(original.status()).toBe(200);
    originalState = (await original.json()).state || {};

    const beforePin = await page.request.get("/api/staff/pin");
    expect(beforePin.status()).toBe(200);
    const pinStatus = await beforePin.json();

    const saved = await page.evaluate(async () => {
      const bridge = (window as unknown as { CDOS_PERSIST: {
        begin: (id: string) => Promise<string>;
        save: () => Promise<void>;
        setOwner: (owner: boolean) => void;
        onTrouble: (fn: (info: { code?: string }) => void) => () => void;
        status: () => { health: string; failures: number };
      } }).CDOS_PERSIST;
      await bridge.begin("tnt-yorkfx");
      bridge.setOwner(true);
      const notices: string[] = [];
      bridge.onTrouble((info) => { if (info.code) notices.push(info.code); });
      (window as unknown as { pinSaveNotices: string[] }).pinSaveNotices = notices;
      const settings = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
      settings.employees = [{ code: "j.masri", pin: "4829" }];
      localStorage.setItem("cdos_settings", JSON.stringify(settings));
      localStorage.setItem("cdos_calc_v1", "pin-save-first");
      await bridge.save();
      const response = await fetch("/api/tenant/state", { credentials: "same-origin" });
      return { state: (await response.json()).state, status: bridge.status() };
    });
    expect(saved.state.cdos_calc_v1).toBe("pin-save-first");
    expect(JSON.parse(saved.state.cdos_settings).employees).toEqual([{ code: "j.masri" }]);
    expect(saved.status).toMatchObject({ health: "ok", failures: 0 });
    const notice = page.locator("#cdos-persist-banner");
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText("Set your till PIN in Settings");
    await expect(notice).not.toContainText("4829");

    /* Another successful save still contains the old browser's PIN.
       The reminder is once per session and never stops ordinary work. */
    const next = await page.evaluate(async () => {
      const win = window as unknown as {
        CDOS_PERSIST: { save: () => Promise<void>; status: () => { health: string } };
        pinSaveNotices: string[];
      };
      localStorage.setItem("cdos_calc_v1", "pin-save-next");
      await win.CDOS_PERSIST.save();
      const response = await fetch("/api/tenant/state", { credentials: "same-origin" });
      return { state: (await response.json()).state, status: win.CDOS_PERSIST.status(), notices: win.pinSaveNotices };
    });
    expect(next.state.cdos_calc_v1).toBe("pin-save-next");
    expect(next.notices.filter((code) => code === "pins_ignored")).toHaveLength(1);
    expect(next.status.health).toBe("ok");
    const afterPin = await page.request.get("/api/staff/pin");
    expect(afterPin.status()).toBe(200);
    expect(await afterPin.json()).toEqual(pinStatus);
  });
}
