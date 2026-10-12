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
  await expect(list.getByText("Demo").first()).toBeVisible();
  const philippines = list.getByText("Parent · Philippines · Cash pickup, Cebuana Lhuillier");
  expect(((await philippines.innerText()).match(/Philippines/g) || []).length).toBe(1);
  const contrast = await list.locator(".phone-search input").evaluate((el) => {
    function channel(v: number): number {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }
    function lum(color: string): number {
      const parts = color.match(/[\d.]+/g);
      if (!parts || parts.length < 3) throw new Error("search colors did not resolve");
      const rgb = parts.slice(0, 3).map((n) => channel(Number(n)));
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }
    const box = el.closest(".phone-search");
    if (!box) throw new Error("the search box is missing");
    const ink = getComputedStyle(el, "::placeholder").color;
    const paper = getComputedStyle(box).backgroundColor;
    const darker = Math.min(lum(ink), lum(paper));
    const lighter = Math.max(lum(ink), lum(paper));
    return (lighter + 0.05) / (darker + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
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

test.describe("a Toronto branch seen from another zone", () => {
  test.use({ timezoneId: "Pacific/Honolulu" });

  test("uses the branch clock, and 24:05 is not a time", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await atDesk(page);
    await openTransfers(page);
    await page.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]");
      const byRef = (ref: string) => rows.find((item: { ref?: string }) => item.ref === ref);
      const toronto = byRef("TR-260618-003");
      const midnight = byRef("TR-260618-002");
      if (!toronto || !midnight) throw new Error("seed transfers are not in the browser book");
      const hand = (row: { timeline?: { by?: string; ts?: string }[] }) => {
        const events = row.timeline || [];
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i] && events[i].by && events[i].by !== "System") return events[i];
        }
        return null;
      };
      const torontoHand = hand(toronto);
      const midnightHand = hand(midnight);
      if (!torontoHand || !midnightHand) throw new Error("a hand stamp is missing");
      /* 04:05Z is 12:05 AM in Toronto (EDT) and 6:05 PM in Honolulu. */
      torontoHand.ts = "2026-06-18T04:05:00Z";
      midnightHand.ts = "2026-06-18 24:05";
      localStorage.setItem("cdos_transfers_v1", JSON.stringify(rows));
    });
    await page.reload();
    await dismissTour(page);
    await openTransfers(page);
    const list = page.locator(".phone-transfers");
    await expect(list.getByText("12:05 AM")).toBeVisible();
    await expect(list).not.toContainText("6:05 PM");
    await expect(list).not.toContainText("24:05");
    await expect(list).not.toContainText("24:00");
    await list.getByText("Rachel Carter to Maria Carter").click();
    await expect(list.getByText("12:05 AM, M. Costa")).toBeVisible();
    await expect(list).not.toContainText("6:05 PM");
    await expect(list).not.toContainText("24:05");
  });
});

test("a record shows the people and does not change the status", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST") posts.push(req.url());
  });
  await openTransfers(page);
  const list = page.locator(".phone-transfers");

  await list.getByText("Jakob Miller to Rohan Miller").click();
  await expect(list.getByRole("heading", { level: 1, name: "Jakob Miller to Rohan Miller" })).toBeVisible();
  await expect(list.locator(".phone-detail-ref")).toHaveText("TR-260618-002");
  await expect(list.getByText("View only. This phone does not change it.")).toBeVisible();
  await expect(list.getByRole("button", { name: "Mark in transit" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Put on hold" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Release" })).toHaveCount(0);
  await expect(list.getByText("Rohan Miller, Sibling")).toBeVisible();
  await expect(list.getByText("Bank deposit, ICICI Bank")).toBeVisible();
  await expect(list).not.toContainText("Mumbai");
  await expect(list).not.toContainText("\u2014");
  await list.getByRole("button", { name: "Transfers" }).click();

  await list.getByRole("tab", { name: "On hold 1" }).click();
  await list.getByText("Brooke Lawson to Lin Wei").click();
  await expect(list.getByRole("button", { name: "Release" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Put on hold" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: /Mark / })).toHaveCount(0);
  await expect(list).not.toContainText("Reportable EFT");
  await list.getByRole("button", { name: "Transfers" }).click();

  await list.getByRole("tab", { name: "Paid out 1" }).click();
  await list.getByText("Rachel Carter to Maria Carter").click();
  await expect(list.getByRole("button", { name: "Put on hold" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Release" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: /Mark / })).toHaveCount(0);
  await expect(list).not.toContainText("Collected in Cebu");
  await list.getByRole("button", { name: "Transfers" }).click();

  await list.getByRole("tab", { name: "In progress 2" }).click();
  await list.getByText("Rachel Carter to Maria Carter").click();
  const detail = page.locator(".phone-transfers");
  const title = detail.getByRole("heading", { level: 1, name: "Rachel Carter to Maria Carter" });
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS("font-size", "22px");
  await expect(title).toHaveCSS("font-weight", "700");
  const ref = detail.locator(".phone-detail-ref");
  await expect(ref).toHaveText("TR-260618-003");
  await expect(ref).toHaveCSS("font-size", "13px");
  await expect(ref).toHaveCSS("color", "rgb(107, 103, 96)");
  const family = await ref.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family.toLowerCase()).toMatch(/mono|menlo/);
  await expect(detail.getByText("Maria Carter, Parent")).toBeVisible();
  await expect(detail.getByText("Philippines")).toBeVisible();
  await expect(detail.getByText("Cash pickup, Cebuana Lhuillier")).toBeVisible();
  await expect(detail.getByText("Cebu City")).toBeVisible();
  await expect(detail.getByText("Family support")).toBeVisible();
  await expect(detail.getByText("Salary")).toBeVisible();
  await expect(detail.getByText("Not on file")).toBeVisible();
  await expect(detail.getByText("10:12 AM, M. Costa")).toBeVisible();
  await expect(detail.getByText("10:14 AM, M. Costa")).toBeVisible();
  await expect(detail.getByText("In transit").first()).toBeVisible();
  await expect(detail).not.toContainText("System");
  await expect(detail).not.toContainText("Partner acknowledged");
  await expect(detail).not.toContainText("48 221 905");
  await expect(detail).not.toContainText("Tracking PIN");
  await expect(detail).not.toContainText("Print receipt");
  await expect(detail).not.toContainText("Generate report");
  await expect(detail).not.toContainText("Example data");
  await expect(detail).not.toContainText("C4410");
  await expect(detail).not.toContainText("Driver's licence");
  await expect(detail.getByText("Demo")).toBeVisible();
  await expect(detail.getByText("Not on the ledger.")).toBeVisible();
  await expect(detail.getByText("Customer pays")).toHaveCount(0);
  await expect(detail.getByText("Beneficiary gets")).toHaveCount(0);
  await expect(detail.getByText("Gross")).toHaveCount(0);
  await expect(detail.getByText("Fee")).toHaveCount(0);
  expect(((await detail.innerText()).match(/Philippines/g) || []).length).toBe(1);
  await expect(detail.locator(".phone-badge")).toHaveText("In transit");
  const stored = await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]");
    const row = rows.find((item: { ref?: string; recvAmt?: number; rate?: number; status?: string }) => item.ref === "TR-260618-003");
    if (!row) throw new Error("seed transfer TR-260618-003 is not in the browser book");
    return { status: row.status, recv: String(row.recvAmt), rate: String(row.rate) };
  });
  expect(stored.status).toBe("transit");
  await expect(detail).not.toContainText(stored.recv);
  await expect(detail).not.toContainText(stored.rate);
  expect(posts.some((url) => url.includes("/api/"))).toBe(false);

  await phoneSweep(page, {
    roots: [".phone-transfers", ".phone-head", "#phone-dock"],
  });
});

test("amounts match the stored ledger row", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
  await openTransfers(page);
  const send = {
    transactionId: "tx_send",
    rate: "21.500000000000",
    inputAmount: "600.50",
    outputAmount: "12910.75",
    from: "CAD",
    to: "PHP",
    feeCad: "9.99",
  };
  const sendFace = { obligationId: "ob_send", transactionId: "tx_send", faceAmount: "12910.75", faceCurrency: "PHP", homeCurrency: "CAD" };
  const recv = {
    transactionId: "tx_recv",
    rate: "0.023936",
    inputAmount: "10000.00",
    outputAmount: "239.36",
    from: "PHP",
    to: "CAD",
    feeCad: null,
  };
  const recvFace = { obligationId: "ob_recv", transactionId: "tx_recv", faceAmount: "239.36", faceCurrency: "CAD", homeCurrency: "CAD" };
  const perHundred = (Number(recv.rate) * 100).toFixed(4);
  await page.evaluate(({ sendTx, recvTx }) => {
    const rows = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]");
    const rachel = rows.find((item: { ref?: string }) => item.ref === "TR-260618-003");
    const jakob = rows.find((item: { ref?: string }) => item.ref === "TR-260618-002");
    const brooke = rows.find((item: { ref?: string }) => item.ref === "TR-260617-019");
    if (!rachel || !jakob || !brooke) throw new Error("seed transfers are not in the browser book");
    rachel.serverTransactionId = sendTx;
    rachel.serverObligationId = "ob_send";
    jakob.serverTransactionId = recvTx;
    jakob.serverObligationId = "ob_recv";
    jakob.direction = "receive";
    brooke.serverTransactionId = "tx_hold";
    brooke.serverObligationId = "ob_hold";
    localStorage.setItem("cdos_transfers_v1", JSON.stringify(rows));
  }, { sendTx: send.transactionId, recvTx: recv.transactionId });
  await page.reload();
  await dismissTour(page);
  await openTransfers(page);

  await page.route("**/api/ledger/transactions**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ transactions: [send, recv] }),
  }));
  await page.route("**/api/ledger/obligations**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ obligations: [sendFace, recvFace], outstanding: { payable: null, receivable: null } }),
  }));

  const list = page.locator(".phone-transfers");
  await list.getByText("Rachel Carter to Maria Carter").click();
  const detail = page.locator(".phone-transfers");
  await detail.locator("summary").click();
  await expect(detail.locator('[data-ledger="input"]')).toHaveAttribute("data-stored", send.inputAmount);
  await expect(detail.locator('[data-ledger="rate"]')).toHaveAttribute("data-stored", send.rate);
  await expect(detail.locator('[data-ledger="face"]')).toHaveAttribute("data-stored", sendFace.faceAmount);
  await expect(detail.locator('[data-ledger="fee"]')).toHaveAttribute("data-stored", send.feeCad);
  await expect(detail.getByText("Customer pays")).toBeVisible();
  await expect(detail.getByText("Amount in")).toHaveCount(0);
  await expect(detail.getByText("Receiver gets")).toBeVisible();
  await expect(detail.getByText("Gross")).toHaveCount(0);
  await expect(detail).not.toContainText("per 100");
  await detail.getByRole("button", { name: "Transfers" }).click();

  await list.getByText("Jakob Miller to Jakob Miller").click();
  await detail.locator("summary").click();
  await expect(detail.locator('[data-ledger="rate"]')).toHaveAttribute("data-stored", recv.rate);
  await expect(detail.locator('[data-ledger="face"]')).toHaveAttribute("data-stored", recvFace.faceAmount);
  await expect(detail.locator('[data-ledger="input"]')).toHaveAttribute("data-stored", recv.inputAmount);
  await expect(detail.locator('[data-ledger="fee"]')).toHaveCount(0);
  await expect(detail.getByText("Amount in")).toBeVisible();
  await expect(detail.getByText("Customer pays")).toHaveCount(0);
  await expect(detail.getByText("Receiver gets")).toBeVisible();
  await expect(detail.locator('[data-ledger="face"]')).toHaveText("239.36 CAD");
  await expect(detail).not.toContainText("2.4935");
  await expect(detail).not.toContainText("249.35");
  await expect(detail).not.toContainText(perHundred);
  await expect(detail).not.toContainText("Gross");
  await expect(detail).not.toContainText("per 100");
  await expect(detail.getByRole("button", { name: /Mark / })).toHaveCount(0);
  const local = await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]");
    const row = rows.find((item: { ref?: string }) => item.ref === "TR-260618-002");
    return row ? { status: row.status as string, recv: String(row.recvAmt) } : { status: "", recv: "" };
  });
  expect(local.status).toBe("sent");
  await expect(detail).not.toContainText(local.recv);
  await detail.getByRole("button", { name: "Transfers" }).click();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/ledger/**", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ code: "AUTHENTICATION_REQUIRED" }),
  }));
  await list.getByRole("tab", { name: "On hold 1" }).click();
  await list.getByText("Brooke Lawson to Lin Wei").click();
  await expect(detail.getByText("Sign in again. No amount is shown.")).toBeVisible();
  await expect(detail.getByText("Customer pays")).toHaveCount(0);
  await expect(detail.getByText("Receiver gets")).toHaveCount(0);
  await expect(detail.getByText("Gross")).toHaveCount(0);
  await expect(detail.locator(".phone-badge")).toHaveText("On hold");
  const covered = await detail.locator(".phone-detail-title").evaluate((title) => {
    const box = title.getBoundingClientRect();
    return [...document.querySelectorAll("[role=status]")].some((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      return r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    });
  });
  expect(covered).toBe(false);
  const held = await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem("cdos_transfers_v1") || "[]");
    const row = rows.find((item: { ref?: string }) => item.ref === "TR-260617-019");
    return row ? row.status : "";
  });
  expect(held).toBe("hold");
  await detail.getByRole("button", { name: "Transfers" }).click();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/api/ledger/**", (route) => route.abort("internetdisconnected"));
  await list.getByRole("tab", { name: "In progress 2" }).click();
  await list.getByText("Rachel Carter to Maria Carter").click();
  await expect(detail.getByText("Offline. No amount is shown.")).toBeVisible();
  await expect(detail.getByText("600.50")).toHaveCount(0);
  await expect(detail.locator(".phone-badge")).toHaveText("In transit");
  await expect(detail.getByRole("button", { name: "Put on hold" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Release" })).toHaveCount(0);
});
