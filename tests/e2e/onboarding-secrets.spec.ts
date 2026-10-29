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
