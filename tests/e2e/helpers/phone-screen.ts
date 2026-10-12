/* What a phone navigation has to land on.

   A click that does nothing used to leave these tests green: the More
   sheet already contains the word Compliance, and a hidden window
   title can be read without the screen having changed. The active
   window's own body has to show that app, and More has to be gone. */
import type { Page } from "@playwright/test";
import { expect } from "../fixtures";

const SCREENS: Record<string, { label: string; text: RegExp }> = {
  /* The board is an iframe. The window body itself has no text, and
     the frame's own words are uppercase. */
  rates: { label: "Rate Board", text: /Buy|Sell|Mid/i },
  ledger: { label: "Ledger", text: /Pay-in volume|Records/ },
  /* The list says "New contact". It does not say "Client", "KYC", or
     "Search" — those live in the window title and the search field's
     placeholder, which innerText omits. */
  clients: { label: "Clients · KYC", text: /New contact/ },
  till: { label: "Cash Drawer", text: /Cash Drawer|Reconcile|Open the till/ },
  transfers: { label: "Transfers", text: /New transfer/ },
  cheques: { label: "Cheques", text: /Cash a cheque/ },
  vault: { label: "Cash on Hand · Vault", text: /\bVault\b/ },
  compliance: { label: "Compliance", text: /Not connected/ },
  tagged: { label: "Tagged", text: /Tagged transactions/ },
  audit: { label: "Audit Trail", text: /APPEND-ONLY|All actions|Transaction posted/ },
  reports: { label: "Reports", text: /End-of-Day Sign-Off/ },
  dashboard: { label: "Dashboard", text: /Cash position/ },
  telegraph: { label: "Texts", text: /\bTexts\b/ },
  calc: { label: "Calculator", text: /Calculator/ },
  loan: { label: "Loan Centre", text: /Loan terms/ },
  pricing: { label: "Pricing & Rates", text: /Default spread|Publish to Rate Board/ },
  store: { label: "Store", text: /On your dock/ },
  /* An owner's desktop rail says "Business profile". A teller never
     gets that rail. The phone list says "PIN and sign-in" for every
     staff member, owner included. */
  settings: { label: "Settings", text: /Business profile|PIN and sign-in/ },
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
