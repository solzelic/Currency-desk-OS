/* The four shared step widgets. Each assertion is the break that
   goes red: an empty summary row drawn, the currency dropped when the
   amount changes, a tile that does not select, a step title that loses
   its space, a dark shell that loses the dark-theme ink, and a
   selected tile whose text fails 4.5:1. */
import { existsSync, mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const STORE = "/cursor/stores/self/pr126";

async function mountWidgets(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/app");
  await page.waitForFunction(
    () =>
      !!(
        window.CDOS &&
        window.CDOS.AmountField &&
        window.CDOS.SummaryList &&
        window.CDOS.ChoiceTiles &&
        window.CDOS.StepHeader &&
        window.React &&
        window.ReactDOM
      ),
  );
  await page.evaluate(() => {
    const React = window.React;
    function Harness() {
      const [value, setValue] = React.useState("12.00");
      const [choice, setChoice] = React.useState("payroll");
      return React.createElement(
        "div",
        { className: "phone-shell", "data-app": "cheques", id: "widget-shell" },
        React.createElement(window.CDOS.StepHeader, {
          step: 2,
          total: 3,
          label: "cheque details",
        }),
        React.createElement(window.CDOS.ChoiceTiles, {
          label: "Kind of cheque",
          value: choice,
          onChange: setChoice,
          options: [
            { id: "payroll", label: "Payroll", detail: "2.0%, 1 day hold" },
            { id: "personal", label: "Personal", detail: "3.5%, 5 day hold" },
          ],
        }),
        React.createElement(window.CDOS.AmountField, {
          label: "Cheque amount",
          value,
          onChange: setValue,
          currency: "CAD",
        }),
        React.createElement(window.CDOS.SummaryList, {
          rows: [
            { label: "Bank", value: "" },
            { label: "Customer", value: "Priya Shah" },
          ],
        }),
      );
    }
    const lock = document.getElementById("lock");
    if (lock) lock.style.display = "none";
    const host = document.createElement("div");
    host.id = "widget-host";
    /* Leave the bottom bar visible. The shell fills this band, so
       the page cream does not show under the dark surface. */
    host.style.cssText =
      "position:fixed;left:0;right:0;top:0;bottom:var(--phone-bar-h,64px);z-index:600;overflow:hidden;background:transparent;padding:0;";
    document.body.appendChild(host);
    window.ReactDOM.createRoot(host).render(React.createElement(Harness));
  });
  await expect(page.locator("#widget-shell")).toBeVisible();
}

/* The shot sits on a signed-in desk so the real bottom bar is in the
   page. The harness covers the desk above that bar. */
async function mountWidgetsOnDesk(page: Page): Promise<void> {
  await page.context().clearCookies();
  await signInAtDesk(page);
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => {
    const React = window.React;
    function Harness() {
      const [value, setValue] = React.useState("12.00");
      const [choice, setChoice] = React.useState("payroll");
      return React.createElement(
        "div",
        { className: "phone-shell", "data-app": "cheques", id: "widget-shell" },
        React.createElement(window.CDOS.StepHeader, {
          step: 2,
          total: 3,
          label: "cheque details",
        }),
        React.createElement(window.CDOS.ChoiceTiles, {
          label: "Kind of cheque",
          value: choice,
          onChange: setChoice,
          options: [
            { id: "payroll", label: "Payroll", detail: "2.0%, 1 day hold" },
            { id: "personal", label: "Personal", detail: "3.5%, 5 day hold" },
          ],
        }),
        React.createElement(window.CDOS.AmountField, {
          label: "Cheque amount",
          value,
          onChange: setValue,
          currency: "CAD",
        }),
        React.createElement(window.CDOS.SummaryList, {
          rows: [
            { label: "Bank", value: "" },
            { label: "Customer", value: "Priya Shah" },
          ],
        }),
      );
    }
    const host = document.createElement("div");
    host.id = "widget-host";
    host.style.cssText =
      "position:fixed;left:0;right:0;top:0;bottom:var(--phone-bar-h,64px);z-index:600;overflow:hidden;background:transparent;padding:0;";
    document.body.appendChild(host);
    window.ReactDOM.createRoot(host).render(React.createElement(Harness));
  });
  await expect(page.locator("#widget-shell")).toBeVisible();
  await expect(page.locator("#phone-dock")).toBeVisible();
}

test("SummaryList leaves out an empty row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountWidgets(page);
  await expect(page.locator(".phone-summary")).toContainText("Priya Shah");
  await expect(page.locator(".phone-summary")).not.toContainText("Bank");
  await expect(page.locator(".phone-summary dd")).toHaveCount(1);
});

test("AmountField keeps the currency when the amount changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountWidgets(page);
  const amount = page.getByLabel("Cheque amount");
  await amount.fill("1000.25");
  await expect(page.locator(".phq-amt-c")).toHaveText("CAD");
  await expect(amount).toHaveValue("1000.25");
});

test("ChoiceTiles selects the tapped tile", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mountWidgets(page);
  const payroll = page.getByRole("option", { name: "Payroll" });
  const personal = page.getByRole("option", { name: "Personal" });
  await expect(payroll).toHaveAttribute("aria-selected", "true");
  const box = await personal.boundingBox();
  expect(box && box.height).toBeGreaterThanOrEqual(56);
  await personal.click();
  await expect(personal).toHaveAttribute("aria-selected", "true");
  await expect(payroll).toHaveAttribute("aria-selected", "false");
});

test("StepHeader keeps a normal space in the title", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mountWidgets(page);
  await expect(page.locator(".phq-steps-t")).toHaveText("Step 2 of 3: cheque details");
  await expect(page.locator(".phq-bar i")).toHaveCount(3);
});

test("a dark shell sets its text colour and the summary inherits the card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountWidgets(page);
  await page.evaluate(() => document.documentElement.setAttribute("data-cdtheme", "dark"));
  const colours = await page.evaluate(() => {
    const shell = document.querySelector("#widget-shell") as HTMLElement;
    const card = document.querySelector(".phone-summary") as HTMLElement;
    const value = document.querySelector(".phone-summary dd") as HTMLElement;
    card.style.color = "rgb(1, 2, 3)";
    const shellInk = getComputedStyle(shell).color;
    const cardInk = getComputedStyle(card).color;
    const valueInk = getComputedStyle(value).color;
    return { shellInk, cardInk, valueInk };
  });
  expect(colours.shellInk).toBe("rgb(246, 243, 236)");
  expect(colours.valueInk).toBe(colours.cardInk);
  expect(colours.valueInk).toBe("rgb(1, 2, 3)");
});

function channel(rgb: string): [number, number, number] {
  const parts = rgb.match(/\d+/g);
  if (!parts || parts.length < 3) throw new Error("not a colour: " + rgb);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function contrast(fg: string, bg: string): number {
  const lum = (rgb: string) => {
    const [r, g, b] = channel(rgb).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hi = Math.max(lum(fg), lum(bg));
  const lo = Math.min(lum(fg), lum(bg));
  return (hi + 0.05) / (lo + 0.05);
}

test("a selected tile clears 4.5:1 in light and in dark", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mountWidgets(page);
  const payroll = page.getByRole("option", { name: "Payroll" });
  const read = () =>
    payroll.evaluate((node) => {
      const tile = getComputedStyle(node);
      const detail = getComputedStyle(node.querySelector("small")!);
      return {
        fill: tile.backgroundColor,
        ink: tile.color,
        detail: detail.color,
      };
    });
  const light = await read();
  expect(contrast(light.ink, light.fill)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(light.detail, light.fill)).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => document.documentElement.setAttribute("data-cdtheme", "dark"));
  const dark = await read();
  expect(dark.fill).toBe("rgb(246, 243, 236)");
  expect(dark.ink).toBe("rgb(20, 19, 15)");
  expect(dark.detail).toBe("rgb(20, 19, 15)");
  expect(contrast(dark.ink, dark.fill)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark.detail, dark.fill)).toBeGreaterThanOrEqual(4.5);
});

test("phone shots of the four widgets at 360 and 390", async ({ page }) => {
  const keep = existsSync("/cursor/stores");
  if (keep) mkdirSync(STORE, { recursive: true });
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 844 });
    if (width === 360) await mountWidgetsOnDesk(page);
    await page.evaluate(() => document.documentElement.setAttribute("data-cdtheme", "dark"));
    await expect(page.getByRole("option", { name: "Payroll" })).toBeVisible();
    await expect(page.locator(".phq-amt-c")).toHaveText("CAD");
    await expect(page.locator(".phq-steps-t")).toContainText("cheque details");
    const shellBottom = await page.locator("#widget-shell").evaluate((node) => node.getBoundingClientRect().bottom);
    const barTop = await page.locator("#phone-dock").evaluate((node) => node.getBoundingClientRect().top);
    expect(shellBottom).toBeGreaterThanOrEqual(barTop - 1);
    if (keep) {
      await page.screenshot({ path: `${STORE}/widgets_${width}.png` });
    }
  }
});
