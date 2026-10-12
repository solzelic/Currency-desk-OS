/* Phone cheque list. The hold on the row is the hold date, not the
   day the cheque came in. Asia/Tokyo is the break: a local midnight
   formatted through toISOString lands on the day before. Sample
   cheques are labelled and a real desk does not show them. A cashier
   is not offered Reverse. The detail title stays dark text in dark
   mode, because the sheet sits outside the phone shell. */
import { existsSync, mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const STORE = "/cursor/stores/self/pr118";

test.use({ timezoneId: "Asia/Tokyo" });

async function mountList(page: Page, role: string): Promise<void> {
  await page.goto("/app");
  await page.waitForFunction(() => !!(window.CDOS && window.CDOS.PhoneCheques && window.CDOS.Phone && window.CDOS._cheques));
  await page.evaluate((who) => {
    const React = window.React;
    const lock = document.getElementById("lock");
    if (lock) lock.style.display = "none";
    const request = window.CDOS.Backend && window.CDOS.Backend.request;
    if (window.CDOS.Backend) {
      window.CDOS.Backend.request = async function (url: string) {
        if (String(url).indexOf("/api/ledger/customers") >= 0) {
          return { customers: [{ customerId: "customer-demo", name: "Priya Shah" }] };
        }
        if (request) return request(url);
        throw new Error(String(url));
      };
    }
    window.CDOS._cheques.ledger = function () {
      return {
        loadCheques: async function () {
          return {
            cheques: [
              {
                chequeId: "real",
                ref: "CHQ-REAL",
                chequeNumber: "104829",
                maker: "Maple Payroll",
                customerName: "Priya Shah",
                customerId: "customer-demo",
                chequeType: "payroll",
                typeLabel: "Payroll",
                currency: "CAD",
                faceAmount: "1000.00",
                feeAmount: "20.00",
                netAmount: "980.00",
                endorsed: true,
                holdDays: 1,
                holdUntil: "2026-10-13",
                receivedDate: "2026-10-12",
                status: "held",
                timeline: [{ status: "held", at: "2026-10-12T08:20:00.000Z", actorId: "tnt:a.singh", note: "" }],
              },
            ],
          };
        },
      };
    };
    function Harness() {
      const [cheques, setCheques] = React.useState([
        {
          id: "demo",
          customer: "Jakob Miller",
          status: "held",
          holdUntil: "2026-06-23",
          receivedDate: "2026-06-18",
          demo: true,
          typeLabel: "Business",
          ref: "CHQ-DEMO",
          amount: 4200,
          netCad: 4074,
          ccy: "CAD",
        },
      ]);
      return React.createElement(window.CDOS.PhoneCheques, {
        rows: [],
        setRows: function () {},
        clients: {},
        setClients: function () {},
        settings: { timezone: "America/Toronto" },
        me: { name: who === "Cashier" ? "M. Costa" : "A. Singh", role: who },
        log: function () {},
        cheques: cheques,
        setCheques: setCheques,
        schedule: window.CDOS._cheques.defaultSchedule(),
        captureSignal: 0,
        onTillChanged: function () {},
      });
    }
    document.documentElement.setAttribute("data-cdtheme", "dark");
    const host = document.createElement("div");
    host.id = "cheque-host";
    host.style.cssText = "position:fixed;inset:0;z-index:100000;background:#F7F6F3;overflow:auto;";
    document.body.appendChild(host);
    window.ReactDOM.createRoot(host).render(React.createElement(Harness));
  }, role);
  await expect(page.locator(".phq-row")).toBeVisible();
}

test("a held row shows the hold date, and a real desk drops the sample", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountList(page, "Cashier");
  const row = page.locator(".phq-row");
  await expect(row).toContainText("Priya Shah");
  await expect(row).toContainText("held to");
  await expect(row).toContainText("Oct 13");
  await expect(row).not.toContainText("Oct 12");
  await expect(page.getByText("Jakob Miller")).toHaveCount(0);
  await expect(page.locator("[data-phone-cheque='sample']")).toHaveCount(0);
  await row.click();
  await expect(page.locator(".phq-sheet h2")).toHaveText("CHQ-REAL");
  await expect(page.getByRole("button", { name: "Reverse" })).toHaveCount(0);
  const ink = await page.locator(".phq-sheet h2").evaluate((node) => getComputedStyle(node).color);
  const value = await page.locator(".phq-sheet .phone-summary dd").first().evaluate((node) => getComputedStyle(node).color);
  expect(ink).toBe("rgb(246, 243, 236)");
  expect(value).toBe("rgb(246, 243, 236)");
});

test("sample cheques are labelled when the desk has no book", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/app");
  await page.waitForFunction(() => !!(window.CDOS && window.CDOS.PhoneCheques && window.CDOS._cheques));
  await page.evaluate(() => {
    const React = window.React;
    const lock = document.getElementById("lock");
    if (lock) lock.style.display = "none";
    window.CDOS._cheques.ledger = function () { return null; };
    const samples = window.CDOS._cheques.defaultCheques();
    if (!samples.length || samples.some((row) => !row.demo)) throw new Error("sample rows are not marked");
    function Harness() {
      return React.createElement(window.CDOS.PhoneCheques, {
        rows: [],
        setRows: function () {},
        clients: {},
        setClients: function () {},
        settings: {},
        me: { name: "M. Costa", role: "Cashier" },
        log: function () {},
        cheques: samples,
        setCheques: function () {},
        schedule: window.CDOS._cheques.defaultSchedule(),
        captureSignal: 0,
        onTillChanged: function () {},
      });
    }
    const host = document.createElement("div");
    host.id = "sample-host";
    host.style.cssText = "position:fixed;inset:0;z-index:100000;background:#F7F6F3;overflow:auto;";
    document.body.appendChild(host);
    window.ReactDOM.createRoot(host).render(React.createElement(Harness));
  });
  await expect(page.locator("[data-phone-cheque='sample']")).toHaveText("Sample cheques. This is not the desk's book.");
  await expect(page.locator(".phq-row", { hasText: "Jakob Miller" }).first()).toBeVisible();
});

test("a senior teller can reverse, and the list is shot at 360 and 390", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mountList(page, "Senior teller");
  if (existsSync("/cursor/stores")) {
    mkdirSync(STORE, { recursive: true });
    await page.screenshot({ path: `${STORE}/list_360.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${STORE}/list_390.png` });
  }
  await page.locator(".phq-row").click();
  await expect(page.getByRole("button", { name: "Reverse" })).toBeVisible();
  if (existsSync("/cursor/stores")) {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: `${STORE}/detail_360.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${STORE}/detail_390.png` });
  }
});
