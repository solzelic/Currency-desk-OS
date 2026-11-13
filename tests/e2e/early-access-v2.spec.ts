import { expect, test, type Page } from "@playwright/test";

/* ============================================================
   Early Access v2.1, walked the way an applicant walks it
   (CD-177 to CD-183), against the real server.

   Three endings:
     · a registered Canadian shop is accepted: the reveal shows the
       CurrencyDesk ID the server issued, and "Start building your desk"
       opens setup with the reference the server gave;
     · a Canadian shop not yet registered: "Your address is held";
     · a shop outside Canada: "Your place is held", with the place in line
       and the invite code the server issued.
   And the page never scrolls a clipped box: at 1440 by 860 the header and
   the card stay where they are while fields take focus.
   ============================================================ */

const ID = /^CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
const unique = () => Math.random().toString(36).slice(2, 8);

async function stepOneAndTwo(page: Page, email: string, shop: string) {
  await page.goto("/early-access");
  await page.getByPlaceholder("you@yourexchange.com").fill(email);
  await page.getByPlaceholder("you@yourexchange.com").press("Enter");
  await page.locator("#cd-shop").fill(shop);
  const slug = shop.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await expect(page.getByText(`${slug}.currencydeskos.com is available`)).toBeVisible();
  await page.getByRole("button", { name: /Reserve it/ }).click();
  await expect(page.getByText("Tell us about the shop.")).toBeVisible();
}

const sec = (page: Page, n: number) => page.locator(`[data-sec="${n}"]`);
/* A question slides open after the one before is answered; a person
   answers it once it is open, and so does this. The line under an open
   question's title is its hint. */
const opened = (page: Page, n: number, hint: string | RegExp) => expect(sec(page, n).getByText(hint)).toBeVisible();
const who = (page: Page, n: number) => page.locator(`[data-who="${n}"]`);

/* The six questions open one after another: where, how much, FINTRAC,
   when, compliance, website. `where` and `fintrac` answer the two that
   differ between the endings. */
async function aboutTheShop(page: Page, where: () => Promise<void>, fintrac: () => Promise<void>) {
  await where();
  await opened(page, 0, /A ballpark/);
  await sec(page, 0).getByRole("button", { name: "$2M to $10M" }).click();
  await sec(page, 0).getByRole("button", { name: "Just one" }).click();
  await fintrac();
  await opened(page, 2, "No wrong answer");
  await sec(page, 2).getByRole("button", { name: "This quarter" }).click();
  await opened(page, 1, "Pick all that apply");
  await sec(page, 1).getByRole("button", { name: /Spreadsheets/ }).click();
  await sec(page, 1).getByRole("button", { name: /^Next/ }).click();
  await opened(page, 3, "If you have one, add the address");
  await sec(page, 3).getByRole("button", { name: "Not yet" }).click();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await expect(page.getByText("Step 4 of 4")).toBeVisible();
}

async function whoRunsIt(page: Page) {
  await page.getByPlaceholder("First name").fill("Daniel");
  await page.getByPlaceholder("Last name").fill("Okafor");
  await who(page, 0).getByRole("button", { name: /^Next/ }).click();
  await who(page, 1).getByRole("button", { name: "Owner" }).click();
  await who(page, 2).getByRole("button", { name: "2 to 5" }).click();
  await page.getByPlaceholder("416 555 0148").fill("416 555 0148");
  await who(page, 3).getByRole("button", { name: /^Next/ }).click();
}

const clipped = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll("body *")].filter((el) => (el.scrollTop || el.scrollLeft) && getComputedStyle(el).overflowY === "hidden").length);

test.describe("Early Access v2.1", () => {
  test.use({ viewport: { width: 1440, height: 860 } });

  test("a registered Canadian shop is accepted with the ID the server issued, and setup opens", async ({ page }) => {
    const email = `ea-${unique()}@yorkcurrency.example`;
    await stepOneAndTwo(page, email, `York Exchange ${unique()}`);

    await aboutTheShop(page,
      () => sec(page, 4).getByRole("button", { name: "ON", exact: true }).click(),
      async () => {
        await opened(page, 5, "Your MSB registration");
        await sec(page, 5).getByRole("button", { name: "Registered", exact: true }).click();
        await page.getByPlaceholder("M12345678").fill("m 1234-5678");
        await sec(page, 5).getByRole("button", { name: /^Next/ }).click();
      });
    await whoRunsIt(page);
    expect(await clipped(page)).toBe(0);

    const sent = page.waitForResponse((r) => r.url().endsWith("/api/enquiries") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    const reply = await sent;
    expect(reply.status()).toBe(201);
    const body = (await reply.json()) as { reference: string; cdId: string };
    expect(body.cdId).toMatch(ID);
    expect(JSON.parse(reply.request().postData() ?? "{}")).toMatchObject({ form: "early-access-v2.1", kind: "early_access" });

    await expect(page.getByText("You're in.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(body.cdId).first()).toBeVisible();
    const open = page.getByRole("link", { name: /Start building your desk/ });
    await expect(open).toHaveAttribute("href", `/onboarding/${body.reference}`);

    /* Call later: the time tapped is booked with the server, inside calling hours */
    await page.getByRole("button", { name: "Call later" }).click();
    const booked = page.waitForResponse((r) => r.url().endsWith(`/api/enquiries/${body.reference}/sam`));
    await page.locator("[data-samgrid] button").first().click();
    const kept = await booked;
    expect(kept.status()).toBe(200);
    expect((await kept.json()) as { at: string; zone: string }).toMatchObject({ zone: expect.any(String) });

    await open.click();
    await expect(page).toHaveURL(new RegExp(`/onboarding/${body.reference}$`));
  });

  test("a Canadian shop not yet registered is told its address is held", async ({ page }) => {
    await stepOneAndTwo(page, `ea-${unique()}@notyet.example`, `Notyet Exchange ${unique()}`);
    await aboutTheShop(page,
      () => sec(page, 4).getByRole("button", { name: "QC", exact: true }).click(),
      async () => {
        await opened(page, 5, "Your MSB registration");
        await sec(page, 5).getByRole("button", { name: "Not yet" }).click();
      });
    await whoRunsIt(page);

    const sent = page.waitForResponse((r) => r.url().endsWith("/api/enquiries") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    expect((await sent).status()).toBe(201);
    await expect(page.getByText("Your address is held.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: /Start building your desk/ })).toHaveCount(0);
  });

  test("a shop outside Canada is told its place, with the code the server issued", async ({ page }) => {
    await stepOneAndTwo(page, `ea-${unique()}@abroad.example`, `Cambio Sur ${unique()}`);
    await aboutTheShop(page,
      async () => {
        await sec(page, 4).getByRole("button", { name: "The shop is outside Canada" }).click();
        await page.getByPlaceholder("Type a country").fill("Mexico");
        await page.getByPlaceholder("Type a country").press("Enter");
      },
      async () => { /* not asked outside Canada */ });
    await whoRunsIt(page);

    const sent = page.waitForResponse((r) => r.url().endsWith("/api/enquiries") && r.request().method() === "POST");
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    const reply = await sent;
    expect(reply.status()).toBe(201);
    const body = (await reply.json()) as { place: number; invite: { code: string } };
    await expect(page.getByText("Your place is held.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(body.invite.code)).toBeVisible();
    await expect(page.getByText(`Nº ${body.place}`, { exact: true })).toBeVisible({ timeout: 10_000 });
  });
});
