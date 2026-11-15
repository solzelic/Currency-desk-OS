import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/* ============================================================
   Sign-up / onboarding v2.1, walked the way an approved owner walks it
   (build doc §10), against the real server, with no screen seeded.

   The ID is typed, never in a link. Nothing personal shows before the
   email code. The code is read from the seam entry's in-memory mailbox
   (server/src/email-test-mailbox.ts), because a real server never writes
   a sign-up code down. Cards are Stripe's: with no Stripe keys here, the
   plan screen says payments are not switched on, nothing is charged, and
   the account stays verified (the desk does not open).
   ============================================================ */

const ID = /^CD-[A-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
const unique = () => Math.random().toString(36).slice(2, 7);
/* Passkeys need an origin the browser trusts: localhost, not 127.0.0.1. */
const local = (path: string) => (test.info().project.use.baseURL ?? "http://127.0.0.1:4173").replace("127.0.0.1", "localhost") + path;

export function application(email: string, shop: string) {
  return {
    kind: "early_access", form: "early-access-v2.1", email, name: "Daniel Okafor",
    details: {
      firstName: "Daniel", lastName: "Okafor", shopName: shop,
      workspace: `${shop.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.currencydeskos.com`, website: "none yet", mode: "early_access",
      jurisdiction: "CA", province: "ON", country: "Canada", state: null,
      fintracRegistered: "Yes", msbNumber: "m 1234-5678", waitlist: false, waitlistReason: null,
      role: "Owner", employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single",
      runningOn: "Excel or Google Sheets", timeline: "This month",
      phone: "+1 4165550148", bestTime: "no call", samConsent: null,
    },
    contactContext: { timezone: "America/Toronto" },
  };
}

export async function apply(request: APIRequestContext, email: string, shop: string): Promise<{ reference: string; cdId: string }> {
  const res = await request.post("/api/enquiries", { data: application(email, shop) });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { reference: string; cdId: string };
  expect(body.cdId).toMatch(ID);
  return body;
}

export async function codeFor(request: APIRequestContext, email: string, after = 0): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`/__test/mail?to=${encodeURIComponent(email)}`);
    const mail = ((await res.json()) as { mail: { text: string; at: number }[] }).mail.filter((m) => m.at > after);
    const m = mail.at(-1)?.text.match(/\b(\d{6})\b/);
    if (m) return m[1]!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no sign-up code in the test mailbox");
}

const card = (page: Page) => page.locator("[data-card]");
export async function press(page: Page, name: RegExp) {
  await card(page).getByRole("button", { name }).last().click();
}

/* welcome → ID → chapter 1 → how will you sign in */
export async function toSignIn(page: Page, cdId: string, typed = cdId) {
  await page.getByRole("button", { name: /^Start/ }).click();
  const field = page.getByPlaceholder("CD-YORK-7K42");
  await field.pressSequentially(typed, { delay: 25 });
  await expect(field).toHaveValue(cdId);
  await expect(page.getByText("That’s your ID. It’s unique to you, and it’s how you sign in from now on.")).toBeVisible();
  await press(page, /^Open it/);
  await expect(page.getByText("It’s reserved for you.")).toBeVisible();
  await press(page, /^Make it mine/);
  await expect(page.getByText("How will you sign in?")).toBeVisible();
}

export async function withPassword(page: Page) {
  await press(page, /email and password/);
  await page.getByPlaceholder("At least 12 characters").fill("harbour tide lantern 42");
  await page.getByPlaceholder("Same again").fill("harbour tide lantern 42");
  await page.locator("[data-foot] button").last().click();
}

export async function proveInbox(page: Page, request: APIRequestContext, email: string, after = 0) {
  await expect(page.getByText("Check your inbox.")).toBeVisible();
  await page.locator('input[autocomplete="one-time-code"]').pressSequentially(await codeFor(request, email, after), { delay: 40 });
}

export async function choosePin(page: Page) {
  await expect(page.getByText("Now, your PIN.", { exact: false })).toBeVisible();
  await press(page, /Choose my PIN/);
  await page.keyboard.type("4821", { delay: 110 });
  await page.waitForTimeout(800);
  await page.keyboard.type("4821", { delay: 110 });
  await expect(page.getByText("What’s your shop called?")).toBeVisible({ timeout: 15_000 });
}

test.describe("sign-up v2.1, the visitor's path", () => {
  test("Early Access hands over to sign-up with the ID typed, and the shop's name is all it shows", async ({ page, request }) => {
    const email = `owner-${unique()}@synthetic.example`;
    const { cdId, reference } = await apply(request, email, `Harbour Exchange ${unique()}`);

    /* the older setup page, opened by reference, still refuses a v2.1 reservation (privacy, #724) */
    const legacy = await request.get(`/api/onboarding/${reference}/state`);
    expect(legacy.status()).toBe(404);

    /* before the email code the server gives the shop's name and nothing else */
    const state = await request.get(`/api/onboarding/${cdId}/state`);
    expect(state.status()).toBe(200);
    expect(Object.keys((await state.json()) as object).sort()).toEqual(["operatingName", "state", "valid"]);

    await page.goto("/onboarding");
    await expect(page.getByText("Welcome. Let’s open your desk.")).toBeVisible();
    /* only a whole ID is ever looked up: part of one, while typed, goes nowhere */
    const lookups: string[] = [];
    page.on("request", (r) => { if (/\/api\/onboarding\/CD-[^/]+\/state/.test(r.url())) lookups.push(r.url()); });
    await page.getByRole("button", { name: /^Start/ }).click();
    const field = page.getByPlaceholder("CD-YORK-7K42");
    await field.pressSequentially(cdId.replace(/-/g, "").toLowerCase().slice(0, 7), { delay: 25 });
    await page.waitForTimeout(800);
    expect(lookups).toHaveLength(0);
    await expect(page.getByText("CD, then four letters and four characters, like CD-YORK-7K42.")).toBeVisible();
    /* a stranger's well-shaped ID is asked about once, and is not theirs */
    await field.fill("");
    await field.pressSequentially("cd abcd 2345", { delay: 25 });
    await expect(field).toHaveValue("CD-ABCD-2345");
    await expect(page.getByText("We don’t have that ID. Check the email we sent you, or have it sent again.")).toBeVisible();
    /* their own, typed with a typographic dash, is theirs */
    await field.fill(cdId.replace(/-/g, "–"));
    await expect(field).toHaveValue(cdId);
    await expect(page.getByText("Recognised", { exact: true })).toBeVisible();
    await press(page, /^Open it/);
    await expect(page.getByText(/It’s reserved for you\./)).toBeVisible();
    /* the details card still says only that they come after the code */
    await expect(page.getByText("Shown once your email code is in")).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);
    await expect(page.getByText("Okafor")).toHaveCount(0);
  });

  test("password, the code, the PIN, every chapter, signed, and the plan screen tells the truth about cards", async ({ page, request }) => {
    const email = `owner-${unique()}@synthetic.example`;
    const shop = `Harbour Exchange ${unique()}`;
    const { cdId } = await apply(request, email, shop);
    await page.goto("/onboarding");
    await toSignIn(page, cdId, cdId.replace(/-/g, "").toLowerCase());
    /* nothing on this screen names the person */
    await expect(page.getByText("Okafor")).toHaveCount(0);
    await withPassword(page);
    await proveInbox(page, request, email);
    await choosePin(page);
    /* nothing about the shop, the owner or their secrets is kept in this browser: only the typed ID, in this tab */
    const kept = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.entries(sessionStorage) }));
    expect(kept.local.filter((k) => k !== "cdSound")).toEqual([]);
    expect(kept.session).toEqual([["cdSignupId", cdId]]);

    /* chapter 2: the shop */
    await press(page, /^That’s it/);
    await card(page).locator("input:visible").last().fill("Harbour Foreign Exchange Inc.");
    await press(page, /^Next/);
    await press(page, /^Continue/);
    await expect(page.getByText("Where’s the shop?")).toBeVisible();
    await press(page, /by hand/i);
    const at = (k: string) => card(page).locator(`input[data-k="${k}"]`);
    await at("street").fill("77 Harbour St");
    await at("unit").fill("204");
    await at("postal").fill("M5J 2V2");
    await at("city").fill("Toronto");
    await at("region").fill("ON");
    await press(page, /^Use this address/);
    await expect(page.getByText("Just the one shop?")).toBeVisible();
    await press(page, /^Just the one/);
    await expect(page.getByText(/FINTRAC registration number/)).toBeVisible();
    await press(page, /^Continue/);

    /* chapter 3: the money */
    await expect(page.getByText("The money.")).toBeVisible();
    await press(page, /^Pick my currencies/);
    await expect(page.getByText("Which currencies do you trade?")).toBeVisible();
    await press(page, /^Continue/);
    await expect(page.getByText("Count the vault.")).toBeVisible();
    /* count the home currency by note: 400 × 100 */
    await card(page).locator("input:visible").first().fill("400");
    await expect(card(page).getByText("40,000 CAD").first()).toBeVisible();
    await press(page, /^Done · next USD/);
    await press(page, /^Continue/);
    await expect(page.getByText("Your rates, online. Free.")).toBeVisible();
    await press(page, /^Good. Now my rules/);

    /* chapter 4: the rules */
    await press(page, /^Set my rules/);
    await expect(page.getByText(/compliance officer/i).first()).toBeVisible();
    await press(page, /That’s me, Daniel Okafor/);
    await press(page, /^Continue/);
    await expect(page.getByText("When should the desk ask for ID?")).toBeVisible();
    await press(page, /^Use this line/);
    await expect(page.getByText("Who else works the counter?")).toBeVisible();
    await press(page, /It’s just me for now/);

    /* chapter 5: sign it */
    await expect(page.getByText("Confirm your desk.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Harbour Foreign Exchange Inc", { exact: false }).first()).toBeVisible();
    const confirmed = page.waitForResponse((r) => r.url().endsWith(`/api/onboarding/${cdId}/confirm`));
    await card(page).getByRole("button", { name: /I confirm/ }).click();
    await press(page, /^Confirm my desk/);
    expect((await confirmed).status()).toBe(200);
    /* what they saw is what the server holds, read back on their own enrolment session */
    const held = (await (await page.request.get(`/api/onboarding/${cdId}/resume`)).json()) as { answers: Record<string, unknown>; pack: { code: string; regulator: string } };
    expect(held.pack).toMatchObject({ code: "CA", regulator: "FINTRAC" });
    expect(held.answers).toMatchObject({
      operatingName: shop, bizName: "Harbour Foreign Exchange Inc.",
      street: "77 Harbour St", unit: "204", city: "Toronto", region: "ON", postal: "M5J 2V2", addrManual: true,
      complianceMode: "me", team: [],
    });
    expect((held.answers.count as Record<string, { mode: string; notes: Record<string, number> }>).CAD).toMatchObject({ mode: "notes", notes: { "100": 400 } });
    await expect(page.getByText("Confirmed. Now, open it.")).toBeVisible();
    await press(page, /^Choose my plan/);

    /* the plan: the server's prices, in the pack's billing currency */
    await expect(page.getByText(`Open ${shop}.`)).toBeVisible();
    await expect(page.getByText("$750").first()).toBeVisible();
    await page.getByRole("button", { name: "Annual" }).click();
    await expect(page.getByText("$539.10").first()).toBeVisible();

    /* no Stripe keys on this server: the card step says so, and nothing opens */
    await page.locator("[data-paybody] button, [data-card] button, button").filter({ hasText: /^Continue$/ }).first().click();
    await page.locator("button").filter({ hasText: /^Continue$/ }).first().click();
    await expect(page.getByText(/Card payments aren['’]t switched on here yet\. Nothing was charged\./).first()).toBeVisible();
    const after = await request.get(`/api/onboarding/${cdId}/state`);
    expect(((await after.json()) as { state: string }).state).not.toBe("active");
  });

  test("the code is wrong five times, then it is burnt; a 1234 PIN is refused", async ({ page, request }) => {
    const email = `owner-${unique()}@synthetic.example`;
    const { cdId } = await apply(request, email, `Harbour Exchange ${unique()}`);
    await page.goto("/onboarding");
    await toSignIn(page, cdId);
    await withPassword(page);
    await expect(page.getByText("Check your inbox.")).toBeVisible();
    const real = await codeFor(request, email);
    const wrong = real === "000000" ? "111111" : "000000";
    const box = page.locator('input[autocomplete="one-time-code"]');
    for (let k = 0; k < 4; k++) {
      await box.pressSequentially(wrong, { delay: 20 });
      await expect(page.getByText(/isn’t right|try/i).first()).toBeVisible();
    }
    await box.pressSequentially(wrong, { delay: 20 });
    await expect(page.getByText(/send it again|Send a new one|new code/i).first()).toBeVisible();
    /* a fresh code works */
    const t = Date.now();
    await page.getByRole("button", { name: /Send it again/ }).click();
    await proveInbox(page, request, email, t);
    await expect(page.getByText("Now, your PIN.", { exact: false })).toBeVisible();
    await press(page, /Choose my PIN/);
    await page.keyboard.type("1234", { delay: 110 });
    await expect(page.getByText("Not that one. 1234 is the first thing anyone tries.")).toBeVisible();
  });

  test("a passkey, made by the browser's own authenticator", async ({ page, request }) => {
    const email = `owner-${unique()}@synthetic.example`;
    const { cdId } = await apply(request, email, `Harbour Exchange ${unique()}`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(local("/onboarding"));
    await toSignIn(page, cdId);
    const verified = page.waitForResponse((r) => r.url().endsWith(`/api/onboarding/${cdId}/passkey/verify`));
    await press(page, /passkey/);
    expect((await verified).status()).toBe(200);
    await proveInbox(page, request, email);
    await expect(page.getByText("Now, your PIN.", { exact: false })).toBeVisible();
  });

  test("a reload comes back where they stopped", async ({ page, request }) => {
    const email = `owner-${unique()}@synthetic.example`;
    const { cdId } = await apply(request, email, `Harbour Exchange ${unique()}`);
    await page.goto("/onboarding");
    await toSignIn(page, cdId);
    await withPassword(page);
    await proveInbox(page, request, email);
    await choosePin(page);
    await press(page, /^That’s it/);
    await card(page).locator("input:visible").last().fill("Harbour Foreign Exchange Inc.");
    await press(page, /^Next/);
    await press(page, /^Continue/);
    await expect(page.getByText("Where’s the shop?")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Where’s the shop?")).toBeVisible({ timeout: 15_000 });
  });

  test("lost ID: the answer is the same whatever the email", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByRole("button", { name: /^Start/ }).click();
    await page.getByRole("button", { name: /Can’t find your ID/ }).click();
    const sent = page.waitForResponse((r) => r.url().endsWith("/api/onboarding/resend-id"));
    await page.locator('input[type="email"]').fill(`nobody-${unique()}@synthetic.example`);
    await page.getByRole("button", { name: /Send my ID/ }).click();
    expect((await sent).status()).toBe(202);
    await expect(page.getByText(/Sent\. Check your inbox\./)).toBeVisible();
  });
});
