/* The ledger receipt label has to clear 4.5:1, the beneficiary row
   names a real relationship, and a 12-hour desk reads 09:00 as 9:00 am. */
import { test, expect, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";

function channel(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrastOf(fg: string, bg: string) {
  const read = (color: string) => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) throw new Error(color);
    const [r, g, b, a] = match[1].split(",").map((part) => Number(part.trim()));
    return { r, g, b, a: a == null ? 1 : a };
  };
  const back = read(bg);
  const front = read(fg);
  const over = front.a < 1
    ? {
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
      }
    : front;
  const lum = (rgb: { r: number; g: number; b: number }) =>
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  const light = Math.max(lum(over), lum(back));
  const dark = Math.min(lum(over), lum(back));
  return (light + 0.05) / (dark + 0.05);
}

const beneficiary = {
  id: "b-ledger",
  name: "Aya Tanaka",
  relationship: "Parent",
  sender: "A. Shah",
  corridor: "PH",
  method: "cash",
  partner: "Cebuana Lhuillier",
  pickupCity: "Manila",
  phone: "+63 917 555 0199",
  address: "12 Mabini",
  bank: "",
  branch: "",
  account: "",
  walletId: "",
  createdAt: "2026-10-20 09:00",
};

const transfer = {
  id: "t-ledger-shot",
  ref: "TR-LEDGER-YEN",
  pin: "12 345 678",
  senderName: "A. Shah",
  beneficiaryId: "b-ledger",
  corridor: "PH",
  ccy: "JPY",
  method: "cash",
  partner: "Cebuana Lhuillier",
  payAmt: 100,
  recvAmt: 10825,
  rate: 108.25,
  fee: 9.99,
  purpose: "Family support",
  sourceOfFunds: "Salary",
  direction: "send",
  date: "2026-10-20",
  status: "created",
  createdBy: "J. Masri",
  receiptLines: ["Beneficiary receives: 10825 JPY"],
  timeline: [{ status: "created", ts: "2026-10-20 09:00", by: "J. Masri" }],
};

async function openDetail(page: Page) {
  await page.addInitScript(({ beneficiary, transfer }) => {
    localStorage.setItem("cdos_beneficiaries_v1", JSON.stringify([beneficiary]));
    localStorage.setItem("cdos_transfers_v1", JSON.stringify([transfer]));
  }, { beneficiary, transfer });
  await signInAtDesk(page, "j.masri");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('#appbar [data-app="transfers"]').click();
  await page.getByRole("button", { name: /TR-LEDGER-YEN/ }).click();
  await expect(page.getByText("Ledger receipt", { exact: true })).toBeVisible({ timeout: 20_000 });
}

test("the ledger receipt label clears 4.5:1 and names the beneficiary", async ({ page }) => {
  await openDetail(page);
  const detail = page.locator("[data-ledger-receipt='1']");
  await expect(detail).toContainText("Beneficiary receives: 10,825 JPY");
  await expect(detail).not.toContainText("10825");
  const pays = page.getByText("Customer pays", { exact: true }).locator("xpath=..");
  await expect(pays).toContainText("100.00 CAD");
  await expect(page.getByText("Aya Tanaka · Parent", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("undefined");

  const colors = await page.getByText("Ledger receipt", { exact: true }).evaluate((el) => {
    const fg = getComputedStyle(el).color;
    let node: Element | null = el;
    let bg = "rgba(0, 0, 0, 0)";
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    return { fg, bg };
  });
  expect(contrastOf(colors.fg, colors.bg)).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByText(/2026-10-20 9:00 am/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("2026-10-20 09:00");

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Print receipt" }).click();
  const printed = await popupPromise;
  await expect(printed.locator("body")).toContainText("Beneficiary receives: 10,825 JPY");
  await expect(printed.locator("body")).toContainText("100.00 CAD");
  await expect(printed.locator("body")).toContainText("108.25 JPY/CAD");
  await expect(printed.locator("body")).not.toContainText("10825");
});
