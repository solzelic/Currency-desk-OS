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

  /* Sol, 14 Nov: when they run "MSB software we use", an optional searchable list asks which,
     styled like the country picker; a name not on the list can be used as typed. */
  test("asks which MSB software, optionally, and sends what they picked", async ({ page }) => {
    await stepOneAndTwo(page, `soft-${unique()}@example.com`, `Software Exchange ${unique()}`);
    await sec(page, 4).getByRole("button", { name: "ON", exact: true }).click();
    await opened(page, 0, /A ballpark/);
    await sec(page, 0).getByRole("button", { name: "$2M to $10M" }).click();
    await sec(page, 0).getByRole("button", { name: "Just one" }).click();
    await opened(page, 5, "Your MSB registration");
    await sec(page, 5).getByRole("button", { name: "Registered", exact: true }).click();
    await sec(page, 5).getByRole("button", { name: /^Next/ }).click();
    await opened(page, 2, "No wrong answer");
    await sec(page, 2).getByRole("button", { name: "This quarter" }).click();
    await opened(page, 1, "Pick all that apply");
    await expect(sec(page, 1).getByRole("button", { name: /Which software/ })).toHaveCount(0);
    await sec(page, 1).getByRole("button", { name: /MSB software we use/ }).click();
    await sec(page, 1).getByRole("button", { name: /Which software/ }).click();
    /* the list is real products, checked on their vendors' sites, and the search narrows it */
    await expect(sec(page, 1).getByRole("button", { name: "CurrencyXchanger", exact: true })).toBeVisible();
    await expect(sec(page, 1).getByRole("button", { name: "Office Exchange", exact: true })).toBeVisible();
    /* it opens near the bottom of the card, so the list comes into view rather than below the fold */
    await expect(sec(page, 1).getByRole("button", { name: "Office Exchange", exact: true })).toBeInViewport({ ratio: 1 });
    /* the row Enter picks is the row drawn on top: matches first, the typed name last */
    await page.getByPlaceholder("Type your software").fill("Office");
    const rows = sec(page, 1).getByRole("listbox").getByRole("button");
    await expect(rows.first()).toHaveText("Office Exchange");
    await expect(rows.last()).toHaveText("Use “Office”");
    await page.getByPlaceholder("Type your software").fill("xchanger");
    await expect(sec(page, 1).getByRole("button", { name: "Office Exchange", exact: true })).toHaveCount(0);
    await sec(page, 1).getByRole("button", { name: "CurrencyXchanger", exact: true }).click();
    await expect(sec(page, 1).getByRole("button", { name: /CurrencyXchanger/ })).toBeVisible();
    /* and one that is not on the list is used as typed */
    await sec(page, 1).getByRole("button", { name: /CurrencyXchanger/ }).click();
    await page.getByPlaceholder("Type your software").fill("Harbour Desk Pro");
    await sec(page, 1).getByRole("button", { name: "Use “Harbour Desk Pro”" }).click();
    await expect(sec(page, 1).getByRole("button", { name: /Harbour Desk Pro/ })).toBeVisible();
    await sec(page, 1).getByRole("button", { name: /^Next/ }).click();
    await expect(sec(page, 1).getByText(/MSB software we use \(Harbour Desk Pro\)/)).toBeVisible();
    await opened(page, 3, "If you have one, add the address");
    await sec(page, 3).getByRole("button", { name: "Not yet" }).click();
    await page.getByRole("button", { name: /^Continue/ }).click();
    await whoRunsIt(page);
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/enquiries") && r.method() === "POST");
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    expect(JSON.parse((await sent).postData() ?? "{}").details).toMatchObject({ software: "Harbour Desk Pro" });
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

    /* The ticket shows the face towards you, with the ID, and hides its back. Safari drew the
       back over the front, mirrored, because it does not always honour backface-visibility; the
       page now hides the face turned away itself, in every engine. */
    const faces = await page.evaluate(() => {
      const label = [...document.querySelectorAll("span")].find((x) => x.textContent === "YOUR CURRENCYDESK ID" && x.closest("[style*='preserve-3d']"));
      const token = label && (label.closest("[style*='preserve-3d']") as HTMLElement);
      if (!token) return null;
      const [front, back] = [...token.children].map((c) => getComputedStyle(c).visibility);
      return { front, back };
    });
    expect(faces).toEqual({ front: "visible", back: "hidden" });
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

    /* The button breathes forever, so "stopped moving" never comes; once it takes clicks, it
       is pressed the way a person presses it. */
    await expect(open).toHaveCSS("pointer-events", "auto", { timeout: 30_000 });
    await open.click({ force: true });
    await expect(page).toHaveURL(new RegExp(`/onboarding/${body.reference}$`));

    /* Setup shows the same CurrencyDesk ID, recognised, not the reference in the link (Sol, 14 Nov). */
    const idField = page.getByPlaceholder("CD-XXXXXX");
    await expect(idField).toHaveValue(body.cdId);
    await expect(page.getByText("Recognised", { exact: true })).toBeVisible();
    /* Somebody else's ID is not a key, so it is not even looked up. */
    const lookups: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/onboarding/CD-ABCD-")) lookups.push(r.url()); });
    await idField.fill("CD-ABCD-2345");
    await expect(page.getByText("To open your setup, use the button in the email we sent you.")).toBeVisible();
    await page.waitForTimeout(800);
    expect(lookups).toHaveLength(0);
    await idField.fill(body.cdId);
    await expect(page.getByText("Recognised", { exact: true })).toBeVisible();
    /* It is theirs to keep and quote. It is not a sign-in yet, so the hint does not say it is. */
    await expect(page.getByText("It stays yours. Quote it whenever you write to us.")).toBeVisible();
    await expect(page.getByText(/sign in from now on/)).toHaveCount(0);
    /* Their own ID typed the way it is read out (no second hyphen), or pasted with a typographic
       dash, is still theirs, and is still never looked up. */
    const own: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/onboarding/") && !r.url().includes(body.reference)) own.push(r.url()); });
    await idField.fill(body.cdId.replace(/-/g, "").toLowerCase());
    await expect(idField).toHaveValue(body.cdId);
    await expect(page.getByText("Recognised", { exact: true })).toBeVisible();
    await idField.fill(body.cdId.replace(/-/g, "\u2013"));
    await expect(idField).toHaveValue(body.cdId);
    await page.waitForTimeout(800);
    expect(own).toHaveLength(0);
    /* A six-character code typed with a space after four letters is still a code, and the
       walkthrough's code is still a code. */
    expect(await page.evaluate(() => {
      const b = (window as unknown as { __cdOnb: { known: Record<string, boolean>; fmtRef(v: string): string; refState(v: string): string } }).__cdOnb;
      b.known["CD-ZAQRBJ"] = true;
      return [b.refState(b.fmtRef("CD ZAQR BJ")), b.fmtRef("cd-walkthru"), b.refState(b.fmtRef("CD-ABCD-2345"))];
    })).toEqual(["ok", "CD-WALKTHRU", "link"]);
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
        /* United States opens the state list by itself. Going straight back to the country list
           focuses the country search, not the state one that is closing. */
        await page.getByPlaceholder("Type a country").fill("United States");
        await page.getByPlaceholder("Type a country").press("Enter");
        await expect(page.getByPlaceholder("Type a state")).toBeVisible();
        await page.evaluate(() => {
          const w = window as unknown as { __focused: string[] };
          w.__focused = [];
          document.addEventListener("focusin", (e) => w.__focused.push((e.target as HTMLInputElement).placeholder || ""), true);
        });
        await sec(page, 4).getByRole("button", { name: /United States/ }).click();
        await expect(page.getByPlaceholder("Type a country")).toBeFocused();
        expect(await page.evaluate(() => (window as unknown as { __focused: string[] }).__focused)).not.toContain("Type a state");
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
    /* the code is on the back of the pass, hidden until the pass turns (sharing turns it) */
    await expect(page.getByText(body.invite.code, { exact: true })).toHaveCount(1);
    await expect(page.getByText(`Nº ${body.place}`, { exact: true })).toBeVisible({ timeout: 10_000 });

    /* Share says the link was copied only when it was */
    const share = page.getByRole("button", { name: /Share my invite link/ });
    await share.click();
    await expect(page.getByText(`We could not copy the link. Your code is ${body.invite.code}.`)).toBeVisible();
    await expect(share).toBeVisible();
    await clipboardWorks(page, true);
    await share.click();
    await expect(page.getByRole("button", { name: /Link copied/ })).toBeVisible();
    await expect(page.getByText(body.invite.code, { exact: true })).toBeVisible({ timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1))).toContain(body.invite.code);
  });
});
