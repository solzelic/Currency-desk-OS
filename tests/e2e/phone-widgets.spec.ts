/* The four shared step widgets. Each assertion is the break that
   goes red: an empty summary row drawn, the currency dropped when the
   amount changes, a tile that does not select, a step title that loses
   its space, and a dark shell that loses the dark-theme ink. */
import { existsSync, mkdirSync } from "node:fs";
import { test, expect } from "./fixtures";

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
    const host = document.createElement("div");
    host.id = "widget-host";
    host.style.cssText =
      "position:fixed;inset:0;z-index:10000;background:#F7F6F3;overflow:auto;padding:16px;";
    document.body.appendChild(host);
    window.ReactDOM.createRoot(host).render(React.createElement(Harness));
  });
  await expect(page.locator("#widget-shell")).toBeVisible();
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

test("phone shots of the four widgets at 360 and 390", async ({ page }) => {
  const keep = existsSync("/cursor/stores");
  if (keep) mkdirSync(STORE, { recursive: true });
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await mountWidgets(page);
    await page.evaluate(() => document.documentElement.setAttribute("data-cdtheme", "dark"));
    await expect(page.getByRole("option", { name: "Payroll" })).toBeVisible();
    await expect(page.locator(".phq-amt-c")).toHaveText("CAD");
    await expect(page.locator(".phq-steps-t")).toContainText("cheque details");
    if (keep) {
      await page.locator("#widget-host").screenshot({
        path: `${STORE}/widgets_${width}.png`,
      });
    }
  }
});
