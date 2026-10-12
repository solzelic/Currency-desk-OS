/* Phone Transfers list. The desktop pipeline picture is not updated here. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const PHONE = { width: 390, height: 844 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayHeading(date: string, book: string): string {
  const text = date.slice(0, 10);
  if (book && text === book) return "Today";
  const y = Number(book.slice(0, 4));
  const m = Number(book.slice(5, 7));
  const d = Number(book.slice(8, 10));
  const utc = new Date(Date.UTC(y, m - 1, d - 1));
  const yesterday = utc.getUTCFullYear() + "-" + String(utc.getUTCMonth() + 1).padStart(2, "0") + "-" + String(utc.getUTCDate()).padStart(2, "0");
  if (text === yesterday) return "Yesterday";
  return MONTHS[Number(text.slice(5, 7)) - 1] + " " + Number(text.slice(8, 10));
}

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function atDesk(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function openTransfers(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="transfers"]').click();
  await dismissTour(page);
  await expect(page.locator('.win.show.active[data-app="transfers"]')).toBeVisible();
  await expect(page.locator(".phone-transfers")).toBeVisible();
}

test("the record list names who sent to whom", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  await openTransfers(page);

  const list = page.locator(".phone-transfers");
  await expect(list.getByRole("heading", { level: 1, name: "Transfers" })).toBeVisible();
  await expect(list.getByRole("tab", { name: "In progress 2" })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("tab", { name: "On hold 1" })).toBeVisible();
  await expect(list.getByRole("tab", { name: "Paid out 1" })).toBeVisible();
  await expect(list.getByRole("tab", { name: "All 4" })).toBeVisible();
  await expect(list.getByText("Sender to beneficiary")).toBeVisible();
  await expect(list.getByText("Rachel Carter to Maria Carter")).toBeVisible();
  await expect(list.getByText("Parent · Philippines · Cash pickup, Cebuana Lhuillier")).toBeVisible();
  await expect(list.getByText("TR-260618-003")).toBeVisible();
  await expect(list.getByText("Jakob Miller to Rohan Miller")).toBeVisible();
  await expect(list.getByText("Sibling · India · Bank deposit, ICICI Bank")).toBeVisible();
  await expect(list.getByText("Brooke Lawson to Lin Wei")).toHaveCount(0);
  await expect(list.getByText("In transit").first()).toBeVisible();
  await expect(list.getByText("Sent").first()).toBeVisible();

  const book = await page.evaluate(() => window.CDOS.businessDate());
  await expect(list.getByText("10:14 AM")).toBeVisible();
  await expect(list.getByText("9:43 AM")).toBeVisible();
  await expect(list.getByText(dayHeading("2026-06-18", book), { exact: true })).toBeVisible();
  await expect(list.getByText("Today,", { exact: false })).toHaveCount(0);
  await expect(list).not.toContainText("Jun 18, 2026");
  await expect(list).not.toContainText("2026-06-18");
  await expect(list).not.toContainText("10:31");
  await expect(list).not.toContainText("48 221 905");
  await expect(list).not.toContainText("Tracking PIN");
  await expect(list).not.toContainText("Print receipt");
  await expect(list).not.toContainText("Generate report");
  await expect(list).not.toContainText("Partner acknowledged");
  await expect(list).not.toContainText("Example data");
  await expect(list).not.toContainText("Joel Carter");
  await expect(list).not.toContainText("C4410");
  await expect(list).not.toContainText("PHP");
  await expect(list).not.toContainText("CAD");
  await expect(list).not.toContainText("Mumbai");
  await expect(list).not.toContainText("\u2014");
  await expect(list).not.toContainText("\u2013");

  await list.getByRole("tab", { name: "On hold 1" }).click();
  await expect(list.getByText("Brooke Lawson to Lin Wei")).toBeVisible();
  await expect(list.getByText("Rachel Carter to Maria Carter")).toHaveCount(0);
  await expect(list.getByText("3:06 PM")).toBeVisible();
  await expect(list.getByText(dayHeading("2026-06-17", book), { exact: true })).toBeVisible();
  await expect(list).not.toContainText("Jun 17, 2026");

  await list.getByRole("tab", { name: "Paid out 1" }).click();
  await expect(list.getByText("Paid out", { exact: true })).toBeVisible();
  await expect(list.getByText("11:22 AM")).toBeVisible();
  await expect(list.getByText(dayHeading("2026-06-16", book), { exact: true })).toBeVisible();
  await expect(list).not.toContainText("Jun 16, 2026");
  await expect(list.getByText("Brooke Lawson to Lin Wei")).toHaveCount(0);

  await list.getByRole("tab", { name: "All 4" }).click();
  await expect(list.getByText("Rachel Carter to Maria Carter")).toHaveCount(2);
  await expect(list.getByText("Brooke Lawson to Lin Wei")).toBeVisible();

  await list.getByRole("tab", { name: "In progress 2" }).click();
  await list.getByLabel("Sender, beneficiary or TR number").fill("TR-260618-002");
  await expect(list.getByText("Jakob Miller to Rohan Miller")).toBeVisible();
  await expect(list.getByText("Rachel Carter to Maria Carter")).toHaveCount(0);
  await list.getByLabel("Sender, beneficiary or TR number").fill("nobody");
  await expect(list.getByText("Nothing matches that search.")).toBeVisible();
  await list.getByLabel("Clear search").click();

  await page.evaluate(() => {
    const key = "cdos_transfers_v1";
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    const row = rows.find((item: { ref?: string }) => item.ref === "TR-260618-003");
    if (!row) throw new Error("seed transfer TR-260618-003 is not in the browser book");
    row.date = window.CDOS.businessDate();
    localStorage.setItem(key, JSON.stringify(rows));
  });
  await page.reload();
  await dismissTour(page);
  await openTransfers(page);
  const again = page.locator(".phone-transfers");
  await expect(again.getByText("10:14 AM")).toBeVisible();
  await expect(again.getByText("Today", { exact: true })).toBeVisible();
  await expect(again.getByText("10:31")).toHaveCount(0);
  await expect(again).not.toContainText("2026-06-18");

  await again.getByRole("button", { name: "+ New transfer record" }).click();
  await expect(page.getByText("Enter an amount to begin")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Customer pays/ })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".phone-task-sheet")).toHaveCount(0);

  await phoneSweep(page, {
    roots: [".phone-transfers", ".phone-head", "#phone-dock"],
  });
});

test("the list groups records from three different days", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  await openTransfers(page);
  await page.evaluate(() => {
    const book = window.CDOS.businessDate();
    const y = Number(book.slice(0, 4));
    const m = Number(book.slice(5, 7));
    const d = Number(book.slice(8, 10));
    const utc = new Date(Date.UTC(y, m - 1, d - 1));
    const yesterday = utc.getUTCFullYear() + "-" + String(utc.getUTCMonth() + 1).padStart(2, "0") + "-" + String(utc.getUTCDate()).padStart(2, "0");
    const rows = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]");
    const byRef = (ref: string) => rows.find((item: { ref?: string }) => item.ref === ref);
    const todayRow = byRef("TR-260618-003");
    const yesterdayRow = byRef("TR-260618-002");
    const olderRow = byRef("TR-260617-019");
    if (!todayRow || !yesterdayRow || !olderRow) throw new Error("seed transfers are not in the browser book");
    todayRow.date = book;
    yesterdayRow.date = yesterday;
    olderRow.date = "2024-06-18";
    localStorage.setItem("cdos_transfers_v1", JSON.stringify(rows));
  });
  await page.reload();
  await dismissTour(page);
  await openTransfers(page);
  const list = page.locator(".phone-transfers");
  await list.getByRole("tab", { name: "All 4" }).click();
  await expect(list.getByText("Today", { exact: true })).toBeVisible();
  await expect(list.getByText("Yesterday", { exact: true })).toBeVisible();
  await expect(list.getByText("Jun 18", { exact: true })).toBeVisible();
  await expect(list.getByText("10:14 AM")).toBeVisible();
  await expect(list.getByText("9:43 AM")).toBeVisible();
  await expect(list.getByText("3:06 PM")).toBeVisible();
  await expect(list.getByText("Today,", { exact: false })).toHaveCount(0);
  await expect(list).not.toContainText("Jun 18, 2026");
  await expect(list).not.toContainText("2024-06-18");
  await expect(list).not.toContainText("10:31");
});

test("the desktop pipeline stays at 1280", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  await openTransfers(page);
  await expect(page.locator(".phone-transfers h1")).toHaveText("Transfers");

  await page.setViewportSize({ width: 1280, height: 800 });
  const win = page.locator('.win.show.active[data-app="transfers"]');
  await expect(win.locator(".phone-transfers")).toHaveCount(0);
  await expect(win.getByText("Transfer pipeline", { exact: true })).toBeVisible();
  await expect(win.getByRole("button", { name: "New transfer" })).toHaveCount(2);
  await expect(win.locator("h1")).toHaveCount(0);
  await expect(win.getByText("Rachel Carter")).toBeVisible();
});
