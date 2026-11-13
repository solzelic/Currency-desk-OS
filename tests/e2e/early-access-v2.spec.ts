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

/* The clipboard, under the test's control: it copies only while
   window.__clipOK is true, and refuses otherwise, as a browser does when
   it is not allowed to. */
async function controlledClipboard(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __clipOK: boolean; __copied: string[] };
    w.__clipOK = false;
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => (w.__clipOK ? (w.__copied.push(text), Promise.resolve()) : Promise.reject(new Error("not allowed"))) },
    });
  });
}
const clipboardWorks = (page: Page, ok: boolean) => page.evaluate((v) => { (window as unknown as { __clipOK: boolean }).__clipOK = v; }, ok);

test.describe("Early Access v2.1", () => {
  test.use({ viewport: { width: 1440, height: 860 } });

  /* Staging's Start a fresh shop opens the website with a ticket; the way
     into the application takes it along (the server honours it only on the
     staging door, which this server is not, so nothing is submitted here). */
  test("the website with a staging ticket leads into the application with it", async ({ page }) => {
    const door = "ab".repeat(16), email = "owner+ab12@staging.invalid";
    await page.goto(`/?door=${door}&email=${encodeURIComponent(email)}`);
    /* the tab keeps the ticket and the address bar lets it go */
    await expect(page).toHaveURL(/\/$/);
    await page.locator("a[data-nav-cta]").click();
    await expect(page.getByPlaceholder("you@yourexchange.com")).toHaveValue(email);
    await expect(page).toHaveURL(/\/early-access$/);

    /* going back to the homepage keeps the staging start, for this tab */
    await page.goto("/");
    await page.locator("a[data-nav-cta]").click();
    await expect(page.getByPlaceholder("you@yourexchange.com")).toHaveValue(email);
  });

  /* A refused ticket (used, expired, or lost in a restart) must never turn
     the next press into a real shop's application. */
  test("after a refused staging ticket, pressing again sends nothing", async ({ page }) => {
    const door = "cd".repeat(16), email = "owner+cd34@staging.invalid";
    const posts: string[] = [];
    await page.route("**/api/enquiries", async (route) => {
      posts.push(route.request().postData() ?? "");
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "staging_ticket" }) });
    });
    await page.goto(`/early-access?door=${door}&email=${encodeURIComponent(email)}`);
    await expect(page.getByPlaceholder("you@yourexchange.com")).toHaveValue(email);
    await page.getByPlaceholder("you@yourexchange.com").press("Enter");
    await page.locator("#cd-shop").fill(`Refused Exchange ${unique()}`);
    await expect(page.getByText(/is available/)).toBeVisible();
    await page.getByRole("button", { name: /Reserve it/ }).click();
    await aboutTheShop(page,
      () => sec(page, 4).getByRole("button", { name: "ON", exact: true }).click(),
      async () => { await opened(page, 5, "Your MSB registration"); await sec(page, 5).getByRole("button", { name: "Registered", exact: true }).click(); await sec(page, 5).getByRole("button", { name: /^Next/ }).click(); });
    await whoRunsIt(page);
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    await expect(page.getByText(/This staging start has been used or has expired/)).toBeVisible({ timeout: 15_000 });
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toMatchObject({ stagingDoor: door });
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    await page.waitForTimeout(1500);
    expect(posts).toHaveLength(1);
  });

  test("every way into the application is v2.1, with no ticket at all", async ({ page }) => {
    await page.goto("/");
    await page.locator("a[data-nav-cta]").click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByText("Step 1 of 4")).toBeVisible();
    await expect(page.getByText("Step 1 of 8")).toHaveCount(0);
  });

  test("a registered Canadian shop is accepted with the ID the server issued, and setup opens", async ({ page }) => {
    await controlledClipboard(page);
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

    /* Copy says copied only when the copy happened (superseded PR #682's rule) */
    await page.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByText(`We could not copy it. Your ID is ${body.cdId}. It is in your email too.`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
    await clipboardWorks(page, true);
    await page.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByText(`${body.cdId} copied. You will need it on the next page.`)).toBeVisible();
    await expect(page.getByRole("button", { name: /Copied/ })).toBeVisible();

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
    await controlledClipboard(page);
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

    /* Share says the link was copied only when it was */
    const share = page.getByRole("button", { name: /Share my invite link/ });
    await share.click();
    await expect(page.getByText(`We could not copy the link. Your code is ${body.invite.code}.`)).toBeVisible();
    await expect(share).toBeVisible();
    await clipboardWorks(page, true);
    await share.click();
    await expect(page.getByRole("button", { name: /Link copied/ })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1))).toContain(body.invite.code);
  });
});

/* Staging only, so on a host whose name says staging: the way back to the
   sign-in page is on every page of the journey, setup included, and it
   signs out on the way so /login shows the sign-in page, not a desk. */
test.describe("the staging way back to sign-in", () => {
  test.use({ launchOptions: { args: ["--host-resolver-rules=MAP cd-staging.test 127.0.0.1"] } });
  for (const path of ["/", "/early-access", "/onboarding/CD-ABCDEF"]) {
    test(`is on ${path} and stays there`, async ({ page }) => {
      const port = new URL(String(test.info().project.use.baseURL)).port;
      await page.route("**/api/staging/signin", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) }));
      let loggedOut = false;
      await page.route("**/api/auth/logout", (route) => { loggedOut = true; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
      await page.goto(`http://cd-staging.test:${port}${path}`);
      await page.waitForTimeout(2500);
      const back = page.locator("#cd-staging-back");
      await expect(back).toBeVisible();
      await expect(back).toHaveText("Staging · Back to sign in");
      await back.click();
      await expect(page).toHaveURL(/\/login$/);
      expect(loggedOut).toBe(true);
    });
  }
});
