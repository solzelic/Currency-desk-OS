import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

/* ============================================================
   Sign-up v2.1, "How will you sign in?", in a real browser: which ways in
   are offered, a passkey cancelled then saved by Chromium's own virtual
   authenticator, and Google's round trip through the real return page
   (web/signup-sso.html) in a popup, with its opener cut off, and on a
   phone.

   The provider is a stand-in at provider.invalid that only redirects back,
   and POST …/sso/callback is answered by the test. That is the browser's
   half alone: the server's token checks run against signed tokens in
   server/tests/signup-v2-1-credential.test.ts. Neither is a real Google
   or Microsoft sign-in.
   ============================================================ */

const unique = () => Math.random().toString(36).slice(2, 7);

/* The visitor's own steps, as tests/e2e/signup-v21.spec.ts walks them (a spec
   file cannot import another). */
async function apply(request: APIRequestContext, email: string, shop: string): Promise<{ cdId: string }> {
  const res = await request.post("/api/enquiries", { data: {
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
  } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { cdId: string };
}
const press = (page: Page, name: RegExp) => page.locator("[data-card]").getByRole("button", { name }).last().click();
async function toSignIn(page: Page, cdId: string) {
  await page.getByRole("button", { name: /^Start/ }).click();
  await page.getByPlaceholder("CD-YORK-7K42").pressSequentially(cdId, { delay: 25 });
  await expect(page.getByText("That’s your ID. It’s unique to you, and it’s how you sign in from now on.")).toBeVisible();
  await press(page, /^Open it/);
  await press(page, /^Make it mine/);
  await expect(page.getByText("How will you sign in?")).toBeVisible();
}
async function proveInbox(page: Page, request: APIRequestContext, email: string) {
  await expect(page.getByText("Check your inbox.")).toBeVisible();
  let code = "";
  for (let i = 0; i < 40 && !code; i++) {
    const mail = ((await (await request.get(`/__test/mail?to=${encodeURIComponent(email)}`)).json()) as { mail: { text: string }[] }).mail;
    code = mail.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
    if (!code) await new Promise((r) => setTimeout(r, 250));
  }
  await page.locator('input[autocomplete="one-time-code"]').pressSequentially(code, { delay: 40 });
}
const local = (path: string) => (test.info().project.use.baseURL ?? "http://127.0.0.1:4173").replace("127.0.0.1", "localhost") + path;
const origin = () => local("");

async function reservation(page: Page) {
  const email = `owner-${unique()}@synthetic.example`;
  const { cdId } = await apply(page.request, email, `Harbour Exchange ${unique()}`);
  return { cdId, email };
}

/* The server here has no Google keys; this says it has, for this page's origin. */
async function googleOffered(context: BrowserContext) {
  await context.route("**/api/onboarding/methods", (route) => route.fulfill({
    json: { password: true, passkey: true, passkeyOrigins: [origin()], google: true, microsoft: false, ssoOrigin: origin() },
  }));
}

/* Each start hands out the next state; the stand-in provider sends the person
   straight back to the return page with what `answer` says. */
async function provider(context: BrowserContext, answer: (state: string) => string) {
  let n = 0;
  await context.route("**/api/onboarding/*/sso/google/start", (route) =>
    route.fulfill({ json: { url: `https://provider.invalid/auth?state=S-${++n}` } }));
  await context.route("https://provider.invalid/**", (route) => {
    const state = new URL(route.request().url()).searchParams.get("state") ?? "";
    return route.fulfill({ status: 302, headers: { location: `${origin()}/onboarding/sso?${answer(state)}&state=${state}` } });
  });
  const callbacks: unknown[] = [];
  await context.route("**/api/onboarding/*/sso/callback", (route) => {
    callbacks.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, kind: "google", state: "enrolling", codeSent: true } });
  });
  return callbacks;
}

const google = (page: Page) => page.locator('[data-logo="google"]');

test.describe("sign-up v2.1, the credential step in the browser", () => {
  test("a server with no Google or Microsoft keys offers neither; password stays", async ({ page }) => {
    const { cdId } = await reservation(page);
    await page.goto(local("/onboarding"));
    await toSignIn(page, cdId);
    await expect(page.locator('[data-logo="password"]')).toBeVisible();
    await expect(google(page)).toHaveCount(0);
    await expect(page.locator('[data-logo="microsoft"]')).toHaveCount(0);
  });

  test("a passkey cancelled at the device leaves every option, and the second try saves it", async ({ page }) => {
    const { cdId, email } = await reservation(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    /* the person presses Cancel on the device's own sheet, once */
    await page.addInitScript(() => {
      const real = navigator.credentials.create.bind(navigator.credentials);
      let cancelled = false;
      navigator.credentials.create = (o?: CredentialCreationOptions) => {
        if (cancelled) return real(o);
        cancelled = true;
        return Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      };
    });
    await page.goto(local("/onboarding"));
    await toSignIn(page, cdId);
    await press(page, /passkey/);
    await expect(page.getByText("The passkey wasn’t created. Nothing was saved. Try again, or choose another way.")).toBeVisible();
    await expect(page.locator('[data-logo="password"]')).toBeVisible();
    const verified = page.waitForResponse((r) => r.url().endsWith(`/api/onboarding/${cdId}/passkey/verify`));
    await press(page, /passkey/);
    expect((await verified).status()).toBe(200);
    await proveInbox(page, page.request, email);
    await expect(page.getByText("Now, your PIN.", { exact: false })).toBeVisible();
  });

  test("Google in a popup: the provider's refusal is one red line; the next try's code is handed back", async ({ page, context }) => {
    const { cdId } = await reservation(page);
    await googleOffered(context);
    let refuse = true;
    const callbacks = await provider(context, () => refuse ? "error=access_denied" : "code=C-ok");
    await page.goto(local("/onboarding"));
    await toSignIn(page, cdId);
    let popup = page.waitForEvent("popup");
    await google(page).click();
    await (await popup).waitForEvent("close");
    await expect(page.getByText("The Google sign-in was cancelled. Nothing was linked. Try again, or choose another way.")).toBeVisible();
    expect(callbacks).toEqual([]);
    refuse = false;
    popup = page.waitForEvent("popup");
    await google(page).click();
    await (await popup).waitForEvent("close");
    await expect(page.getByText("Check your inbox.")).toBeVisible();
    expect(callbacks).toEqual([{ provider: "google", code: "C-ok", state: "S-2" }]);
  });

  test("a provider page that cuts the popup off from its opener still hands the code back", async ({ page, context }) => {
    const { cdId } = await reservation(page);
    await googleOffered(context);
    const callbacks = await provider(context, () => "code=C-coop");
    /* what Cross-Origin-Opener-Policy on the provider's page does to the return page */
    await context.addInitScript(() => {
      if (location.pathname === "/onboarding/sso") Object.defineProperty(window, "opener", { value: null, configurable: true });
    });
    await page.goto(local("/onboarding"));
    await toSignIn(page, cdId);
    const popup = page.waitForEvent("popup");
    await google(page).click();
    await (await popup).waitForEvent("close");
    await expect(page.getByText("Check your inbox.")).toBeVisible();
    expect(callbacks).toEqual([{ provider: "google", code: "C-coop", state: "S-1" }]);
  });

  test("on a phone the page itself goes to Google and back; the code leaves the address bar; a refusal stays on the sign-in screen", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { cdId } = await reservation(page);
    await googleOffered(context);
    let refuse = true;
    const callbacks = await provider(context, () => refuse ? "error=access_denied" : "code=C-phone");
    await page.goto(local("/onboarding"));
    await toSignIn(page, cdId);
    await google(page).click();
    await expect(page.getByText("The Google sign-in was cancelled. Nothing was linked. Try again, or choose another way.")).toBeVisible();
    expect(page.url()).toBe(local("/onboarding"));
    expect(callbacks).toEqual([]);
    refuse = false;
    await google(page).click();
    await expect(page.getByText("Check your inbox.")).toBeVisible();
    expect(page.url()).toBe(local("/onboarding"));
    expect(callbacks).toEqual([{ provider: "google", code: "C-phone", state: "S-2" }]);
  });
});


test("a readiness outage does not retry on every credential-screen render", async ({ page, context }) => {
  const { cdId } = await reservation(page);
  let lookups = 0;
  await context.route("**/api/onboarding/methods", route => {
    lookups++;
    return route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await page.goto(local("/onboarding"));
  await toSignIn(page, cdId);
  await page.locator('[data-logo="password"]').click();
  await page.getByPlaceholder("At least 12 characters").fill("synthetic long phrase");
  await expect(page.getByPlaceholder("At least 12 characters")).toHaveValue("synthetic long phrase");
  expect(lookups).toBe(1);
});

test("Back retires a pending provider start; returning to the screen cannot launch its popup", async ({ page, context }) => {
  const { cdId } = await reservation(page);
  await googleOffered(context);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const startSeen = new Promise<void>(resolve => { started = resolve; });
  await context.route("**/api/onboarding/*/sso/google/start", async route => {
    started(); await held;
    await route.fulfill({ json: { url: "https://provider.invalid/auth?state=retired" } });
  });
  const providerVisits: string[] = [];
  await context.route("https://provider.invalid/**", route => {
    providerVisits.push(route.request().url()); return route.fulfill({ body: "Unexpected provider visit" });
  });
  await page.goto(local("/onboarding")); await toSignIn(page, cdId);
  const opening = page.waitForEvent("popup"); await google(page).click();
  const popup = await opening; await startSeen;
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  const completed = page.waitForResponse(r => r.url().endsWith("/sso/google/start"));
  release(); await completed;
  await press(page, /^Make it mine/);
  await expect(page.getByText("How will you sign in?")).toBeVisible();
  await page.locator('[data-logo="password"]').click();
  await expect(page.getByPlaceholder("At least 12 characters")).toBeVisible();
  expect(providerVisits).toEqual([]);
});
