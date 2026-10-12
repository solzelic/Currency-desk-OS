/* The cash sheet. Asia/Tokyo is the hold-preview break: the line
   must say 13 October when today is 12 October and the hold is one
   day. A refused save must not leave a cashed row. 1,000.25 at 2%
   is 20.01, and the posted cheque is signed only because the
   switch is on. */
import { existsSync, mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const STORE = "/cursor/stores/self/pr118";

test.use({ timezoneId: "Asia/Tokyo" });

async function mountFlow(page: Page): Promise<void> {
  await page.goto("/app");
  await page.waitForFunction(() => !!(window.CDOS && window.CDOS.PhoneCheques && window.CDOS._cheques));
  await page.evaluate(() => {
    const React = window.React;
    const lock = document.getElementById("lock");
    if (lock) lock.style.display = "none";
    window.CDOS.TODAY = "2026-10-12";
    localStorage.setItem("cdos_settings", JSON.stringify({ timezone: "America/Toronto" }));
    const posts: unknown[] = [];
    (window as unknown as { __chequePosts: unknown[]; __chequeFail: boolean }).__chequePosts = posts;
    (window as unknown as { __chequeFail: boolean }).__chequeFail = false;
    window.CDOS._cheques.ledger = function () {
      return {
        loadCheques: async function () { return { cheques: [] }; },
        syncCustomer: async function () { return { customerId: "c1" }; },
        asMoney: function (amount: number) { return Number(amount).toFixed(2); },
        cashCheque: async function (body: { chequeNumber: string; faceAmount: string; feeAmount: string; endorsed: boolean; holdDays: number; chequeType: string; typeLabel: string; maker: string }) {
          posts.push(body);
          if ((window as unknown as { __chequeFail: boolean }).__chequeFail) {
            throw new Error("The fee does not match this cheque. Nothing was cashed.");
          }
          const net = (Number(body.faceAmount) - Number(body.feeAmount)).toFixed(2);
          return {
            cheque: {
              chequeId: "new-" + posts.length,
              ref: "CHQ-NEW",
              chequeNumber: body.chequeNumber,
              maker: body.maker,
              customerName: "Priya Shah",
              customerId: "c1",
              chequeType: body.chequeType,
              typeLabel: body.typeLabel,
              currency: "CAD",
              faceAmount: body.faceAmount,
              feeAmount: body.feeAmount,
              netAmount: net,
              endorsed: body.endorsed,
              holdDays: body.holdDays,
              holdUntil: "2026-10-13",
              receivedDate: "2026-10-12",
              status: "held",
              timeline: [{ status: "held", at: "2026-10-12T08:20:00.000Z", actorId: "tnt:a.singh", note: "" }],
            },
          };
        },
        loadLedger: async function () { return []; },
        mergeRows: function (current: unknown) { return current; },
      };
    };
    function Harness() {
      const [cheques, setCheques] = React.useState([]);
      return React.createElement(window.CDOS.PhoneCheques, {
        rows: [],
        setRows: function () {},
        clients: {},
        setClients: function () {},
        settings: { timezone: "America/Toronto" },
        me: { name: "A. Singh", role: "Senior teller" },
        log: function () {},
        cheques: cheques,
        setCheques: setCheques,
        schedule: window.CDOS._cheques.defaultSchedule(),
        captureSignal: 0,
        onTillChanged: function () {},
      });
    }
    const host = document.createElement("div");
    host.id = "flow-host";
    host.style.cssText = "position:fixed;inset:0;background:#F7F6F3;overflow:auto;";
    document.body.appendChild(host);
    window.ReactDOM.createRoot(host).render(React.createElement(Harness));
  });
  await expect(page.getByRole("button", { name: "Cash a cheque" })).toBeVisible();
}

async function reachPay(page: Page, amount: string): Promise<void> {
  await page.getByRole("button", { name: "Cash a cheque" }).click();
  await page.getByLabel("Customer").fill("Priya Shah");
  await page.getByRole("button", { name: /Use / }).click();
  await page.getByRole("option", { name: /Payroll/ }).click();
  await page.getByLabel("Cheque amount").fill(amount);
  await page.getByRole("button", { name: "Next: cheque details" }).click();
  await page.locator(".phq-sheet").getByRole("textbox", { name: "Cheque number", exact: true }).fill("104829");
  await page.locator(".phq-sheet").getByRole("textbox", { name: "Who wrote the cheque", exact: true }).fill("Maple Payroll");
  const signed = page.getByRole("switch", { name: "Signed on the back" });
  await expect(signed).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Next: check and pay" })).toBeDisabled();
  await signed.click();
  await expect(signed).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Next: check and pay" }).click();
}

test("the hold preview matches the saved day, and the fee rounds half up", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountFlow(page);
  await reachPay(page, "1000.25");
  await expect(page.getByText("Held to Oct 13")).toBeVisible();
  await expect(page.getByText("Held to Oct 12")).toHaveCount(0);
  await expect(page.getByText("20.01 CAD", { exact: true })).toBeVisible();
  const ink = await page.evaluate(() => {
    document.documentElement.setAttribute("data-cdtheme", "dark");
    const title = getComputedStyle(document.querySelector(".phq-sheet h2")!).color;
    const value = getComputedStyle(document.querySelector(".phq-sheet .phone-summary dd")!).color;
    document.documentElement.removeAttribute("data-cdtheme");
    return { title, value };
  });
  expect(ink.title).toBe("rgb(246, 243, 236)");
  expect(ink.value).toBe("rgb(246, 243, 236)");
  if (existsSync("/cursor/stores")) {
    mkdirSync(STORE, { recursive: true });
    await page.screenshot({ path: `${STORE}/step3_390.png` });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: `${STORE}/step3_360.png` });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.locator("[data-phone-cheque='pay']").evaluate((btn: HTMLButtonElement) => {
    btn.click();
    btn.click();
  });
  await expect(page.getByRole("status").filter({ hasText: "Cheque cashed" })).toBeVisible();
  const posted = await page.evaluate(() => (window as unknown as { __chequePosts: { endorsed: boolean; feeAmount: string; faceAmount: string }[] }).__chequePosts);
  expect(posted).toHaveLength(1);
  expect(posted[0].endorsed).toBe(true);
  expect(posted[0].faceAmount).toBe("1000.25");
  expect(posted[0].feeAmount).toBe("20.01");
});

test("a refused save is not kept as a cashed row", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mountFlow(page);
  await page.evaluate(() => { (window as unknown as { __chequeFail: boolean }).__chequeFail = true; });
  await reachPay(page, "1000.00");
  await page.locator("[data-phone-cheque='pay']").click();
  await expect(page.getByText("The cheque was not cashed. Nothing was saved. Try again.")).toBeVisible();
  await expect(page.getByText("The fee does not match this cheque. Nothing was cashed.")).toBeVisible();
  await expect(page.getByText(/Missing /)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("104829")).toHaveCount(0);
  await expect(page.getByText("CHQ-NEW")).toHaveCount(0);
});
