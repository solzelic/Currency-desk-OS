/* ============================================================
   Sign-up keeps no secret in this browser's storage (#431).

   The onboarding page saves its answers under cdos_onb_v2 so a reload
   resumes the flow. Before #431 that copy held the owner's password, the
   verify code and every card field in plain text, and it outlived the
   launch.

   These walk the page with no invite code, the page's own offline mode:
   nothing is sent to a server and launch is simulated, so a test card
   number never leaves the browser. The design reopens on the screen it
   last saved, which is how each test lands on the screen it needs.
   The last two open on an invite code so the save PUTs, and a route
   reads that body. The card number is the Stripe test number.
   ============================================================ */
import { test, expect, type Page } from "@playwright/test";

const KEY = "cdos_onb_v2";
const TEST_CARD = "4242 4242 4242 4242";

/* Everything a screen from 5 to 15 needs to count as answered, except the
   secrets, which the page must never be handed back. */
const ANSWERS = {
  country: "CA",
  operatingName: "Harbour Exchange",
  ownerName: "Alex Roy",
  ownerEmail: "alex@harbour.example",
  phone: "(416) 555-0148",
  currencies: ["USD", "EUR"],
  complianceMode: "me",
  siteMode: "none",
  city: "Toronto",
};

const stored = (page: Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as { i: number; data: Record<string, unknown> });
  }, KEY);

const rawStored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);

/* Opens the page on screen `i` with `data` already saved, the way a
   person who reloads mid sign-up arrives. */
async function openAt(page: Page, i: number, data: Record<string, unknown>) {
  await page.goto("/onboarding");
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [KEY, JSON.stringify({ i, data })] as const);
  await page.reload();
}

const SECRET_FIELDS = ["ownerPass", "code", "cardNum", "cardExp", "cardCvc", "cardName", "backup"];

function expectNoSecrets(saved: { data: Record<string, unknown> } | null) {
  expect(saved).not.toBeNull();
  for (const k of SECRET_FIELDS) expect(saved!.data, k).not.toHaveProperty(k);
  for (const k of Object.keys(saved!.data)) expect(k.startsWith("card"), k).toBe(false);
}

test("an old saved copy with secrets in it is cleaned when the page loads", async ({ page }) => {
  await openAt(page, 5, {
    ...ANSWERS,
    ownerPass: "hunter2-old",
    code: "123456",
    cardNum: "4242424242424242", cardExp: "12/29", cardCvc: "123", cardName: "Alex Roy",
    backup: { num: "5555555555554444", exp: "11/28", cvc: "456" },
  });
  await expect(page.getByPlaceholder("At least 6 characters")).toBeVisible();

  const raw = await rawStored(page);
  for (const value of ["hunter2-old", "123456", "4242424242424242", "5555555555554444"]) {
    expect(raw).not.toContain(value);
  }
  expectNoSecrets(await stored(page));
  expect((await stored(page))!.data.city).toBe("Toronto");
  await expect(page.getByPlaceholder("At least 6 characters")).toHaveValue("");
});

test("a password typed mid sign-up is never saved, and a reload asks for it again", async ({ page }) => {
  await openAt(page, 5, ANSWERS);
  const password = page.getByPlaceholder("At least 6 characters");
  await password.fill("harbour-pass-2026");

  await expect.poll(async () => (await stored(page))?.data.ownerEmail).toBe(ANSWERS.ownerEmail);
  expect(await rawStored(page)).not.toContain("harbour-pass-2026");
  expectNoSecrets(await stored(page));

  await page.reload();
  await expect(page.getByPlaceholder("At least 6 characters")).toHaveValue("");
  await expect(page.locator(`input[value="${ANSWERS.ownerEmail}"]`)).toBeVisible();
});

test("card details typed on the last screen are never saved", async ({ page }) => {
  await openAt(page, 15, ANSWERS);
  await page.getByPlaceholder("Card number").fill(TEST_CARD);
  await page.getByPlaceholder("MM / YY").fill("1229");
  await page.getByPlaceholder("CVC").fill("123");
  await page.getByPlaceholder("Name on card").fill("Alex Roy");

  await expect.poll(async () => (await stored(page))?.data.city).toBe("Toronto");
  expect(await rawStored(page)).not.toContain("4242");
  expectNoSecrets(await stored(page));

  /* The design restarts from the first screen when the payment screen is
     reloaded, so come back to it the way a person would, with what was
     actually saved. */
  await openAt(page, 15, (await stored(page))!.data);
  await expect(page.getByPlaceholder("Card number")).toHaveValue("");
  await expect(page.getByPlaceholder("CVC")).toHaveValue("");
  await expect(page.getByPlaceholder("Name on card")).toHaveValue("");
});

test("after launch the saved copy is gone", async ({ page }) => {
  await openAt(page, 5, ANSWERS);
  await page.getByPlaceholder("At least 6 characters").fill("harbour-pass-2026");

  /* Walk forward with the primary button until the verify screen. */
  const next = page.locator('button[style*="--cd-cta"]').first();
  const codeBox = page.getByPlaceholder("000000");
  for (let step = 0; step < 12 && !(await codeBox.isVisible()); step++) {
    await expect(next).toBeEnabled();
    await next.click();
  }
  await codeBox.fill("424242");
  expectNoSecrets(await stored(page));

  const card = page.getByPlaceholder("Card number");
  await expect(card).toBeVisible();
  await card.fill(TEST_CARD);
  await page.getByPlaceholder("MM / YY").fill("1229");
  await page.getByPlaceholder("CVC").fill("123");
  await page.getByPlaceholder("Name on card").fill("Alex Roy");
  expectNoSecrets(await stored(page));

  await page.getByRole("button", { name: /tick here to accept it/ }).click();
  await page.getByRole("button", { name: `Open ${ANSWERS.operatingName}` }).click();
  await expect.poll(() => rawStored(page)).toBeNull();

  /* The done screen keeps re-rendering, and none of that writes it back. */
  await page.waitForTimeout(1500);
  expect(await rawStored(page)).toBeNull();
});

/* Invite in the path: save() PUTs. No code would stay offline and never
   call the network. GET state is 404 so the seeded screen stays. */
const REF = "CD-HBRFX2";
const PASS = "harbour-pass-2026";

type SaveBody = { at?: number; data?: Record<string, unknown> };

async function onNetwork(page: Page, seen: { put: SaveBody[]; launch: SaveBody[] }) {
  await page.route("**/api/onboarding/*/state", (route) => {
    if (route.request().method() !== "PUT") {
      route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    seen.put.push(route.request().postDataJSON() as SaveBody);
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/onboarding/*/verify/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, channel: "email", sentTo: ANSWERS.ownerEmail }),
    }));
  await page.route("**/api/onboarding/*/launch", (route) => {
    seen.launch.push(route.request().postDataJSON() as SaveBody);
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [KEY, JSON.stringify({ i: 5, data: ANSWERS })] as const,
  );
  await page.goto(`/onboarding/${REF}`);
  await expect(page.getByPlaceholder("At least 6 characters")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __cdOnb?: { code?: string } }).__cdOnb?.code)).toBe(REF);
}

async function typePasswordAndCard(page: Page) {
  await page.getByPlaceholder("At least 6 characters").fill(PASS);
  const next = page.locator('button[style*="--cd-cta"]').first();
  const codeBox = page.getByPlaceholder("000000");
  for (let step = 0; step < 12 && !(await codeBox.isVisible()); step++) {
    await expect(next).toBeEnabled();
    await next.click();
  }
  await codeBox.fill("424242");
  const card = page.getByPlaceholder("Card number");
  await expect(card).toBeVisible();
  await card.fill(TEST_CARD);
  await page.getByPlaceholder("MM / YY").fill("1229");
  await page.getByPlaceholder("CVC").fill("123");
  await page.getByPlaceholder("Name on card").fill("Alex Roy");
}

function expectSaveHasNoSecrets(body: SaveBody) {
  const data = body.data ?? {};
  for (const k of ["ownerPass", "code", "backup"]) expect(data, k).not.toHaveProperty(k);
  for (const k of Object.keys(data)) expect(k.startsWith("card"), k).toBe(false);
  const raw = JSON.stringify(body);
  expect(raw).not.toContain(PASS);
  expect(raw).not.toContain("4242");
  expect(data.city).toBe("Toronto");
}

test("a network state save carries no password, code or card", async ({ page }) => {
  const seen = { put: [] as SaveBody[], launch: [] as SaveBody[] };
  await onNetwork(page, seen);
  await typePasswordAndCard(page);
  await expect.poll(() => seen.put.length).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  for (const body of seen.put) expectSaveHasNoSecrets(body);
});

test("launch still sends the password", async ({ page }) => {
  const seen = { put: [] as SaveBody[], launch: [] as SaveBody[] };
  await onNetwork(page, seen);
  await typePasswordAndCard(page);
  await page.getByRole("button", { name: /tick here to accept it/ }).click();
  await page.getByRole("button", { name: `Open ${ANSWERS.operatingName}` }).click();
  await expect.poll(() => seen.launch.length).toBeGreaterThan(0);
  expect(seen.launch[0].data?.ownerPass).toBe(PASS);
});

/* After the desk is open, GET state carries createdDesk. A reload, the
   marketing page, and /onboarding must not bring cdos_onb_v2 back or PUT. */
test("after launch a reload does not restore the saved copy or PUT state", async ({ page }) => {
  const puts: SaveBody[] = [];
  let opened = false;
  await page.route("**/api/onboarding/*/state", (route) => {
    const put = route.request().method() === "PUT";
    if (put && opened) puts.push(route.request().postDataJSON() as SaveBody);
    if (put || !opened) {
      return route.fulfill({ status: put ? 200 : 404, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ at: 0, createdDesk: "tnt-harbour", data: { ...ANSWERS, cdId: REF } }),
    });
  });
  await page.route("**/api/onboarding/*/verify/*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"channel":"email"}' }));
  await page.route("**/api/onboarding/*/launch", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));

  await page.goto(`/onboarding/${REF}`);
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [KEY, JSON.stringify({ i: 5, data: ANSWERS })] as const,
  );
  await page.reload();
  await expect(page.getByPlaceholder("At least 6 characters")).toBeVisible();
  await typePasswordAndCard(page);
  await page.getByRole("button", { name: /tick here to accept it/ }).click();
  await page.getByRole("button", { name: `Open ${ANSWERS.operatingName}` }).click();
  await expect.poll(() => rawStored(page)).toBeNull();
  await page.waitForTimeout(800);
  opened = true;

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/onboarding/${REF}`);
    await expect(page.getByText(/Let.s open your desk/)).toBeVisible();
    expect(await rawStored(page), String(width)).toBeNull();
    expect(puts, String(width)).toEqual([]);
  }
  await page.goto("/");
  expect(await rawStored(page)).toBeNull();
  await page.goto("/onboarding");
  expect(await rawStored(page)).toBeNull();
  expect(puts).toEqual([]);
});
