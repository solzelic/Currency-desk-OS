/* What a phone navigation has to land on.

   A click that does nothing used to leave these tests green: the More
   sheet already contains the word Compliance, and a hidden window
   title can be read without the screen having changed. The active
   window's own body has to show that app, and More has to be gone. */
import type { Page } from "@playwright/test";
import { expect } from "../fixtures";

const SCREENS: Record<string, { label: string; text: RegExp }> = {
  rates: { label: "Rate Board", text: /Buy|Sell|Mid|Rate/ },
  ledger: { label: "Ledger", text: /Pay-in volume|Records/ },
  clients: { label: "Clients · KYC", text: /New contact|Needs attention/ },
  till: { label: "Cash Drawer", text: /Cash drawer|Reconcile|Open the till/ },
  transfers: { label: "Transfers", text: /Transfer|Send|Beneficiar/ },
  cheques: { label: "Cheques", text: /Cheque|Hold/ },
  vault: { label: "Cash on Hand · Vault", text: /Vault|safe|float/i },
  compliance: { label: "Compliance", text: /Not connected/ },
  tagged: { label: "Tagged", text: /Tag/ },
  audit: { label: "Audit Trail", text: /Audit/ },
  reports: { label: "Reports", text: /End-of-Day Sign-Off/ },
  dashboard: { label: "Dashboard", text: /Cash position|Dashboard/ },
  telegraph: { label: "Texts", text: /Text|Message/ },
  calc: { label: "Calculator", text: /Calculator|[0-9]/ },
  loan: { label: "Loan Centre", text: /Loan|payment|Monthly/ },
  pricing: { label: "Pricing & Rates", text: /Pric|Spread|Rate/ },
  store: { label: "Store", text: /Store|App/ },
  settings: { label: "Settings", text: /Settings|Business|PIN/ },
};

export async function expectPhoneMore(page: Page): Promise<void> {
  const sheet = page.locator("#phone-more");
  await expect(sheet).toBeVisible();
  /* "Search apps" is the field's accessible name. The placeholder
     is "Search", so the sheet's text does not contain those words. */
  await expect(sheet.getByRole("textbox", { name: "Search apps" })).toBeVisible();
  await expect(sheet).toContainText("Lock the desk");
}

export async function expectPhoneApp(page: Page, id: string): Promise<void> {
  const screen = SCREENS[id];
  expect(screen, id).toBeTruthy();
  await expect(page.locator("#phone-more")).toBeHidden();
  const body = page.locator(`.win.show.active[data-app="${id}"] [data-screen-label="${screen.label}"]`);
  await expect(body).toBeVisible();
  /* The rate board is an iframe. The window body around it has no
     text of its own, so the words are read from the frame. */
  if (id === "rates") {
    await expect(page.frameLocator('.win.show.active[data-app="rates"] iframe').locator("body")).toContainText(screen.text);
    return;
  }
  await expect(body).toContainText(screen.text);
  if (id === "compliance") {
    await expect(page.getByTestId("sanctions-screening-tile")).toBeVisible();
  }
}
