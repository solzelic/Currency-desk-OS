/* A locked password step on a phone.

   Both counters trip at ten. Spend at most ten guesses on an id that
   is not a person at the desk. Each real-lock case restores its own
   persistent counters so later specs do not inherit a locked connection.
   No seeded teller is locked. These cases need a disposable Postgres DB.

   While the lock holds, the button reads Sign in and is disabled.
   A staff id with no @ comes back as Sign in. An email address
   comes back as Send my code.
   The sentence names that time once, without a zone label.
   A 503 is intercepted, so it does not spend a guess. */
import type { Locator, Page } from "@playwright/test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { test, expect } from "./fixtures";

type Counter = { bucket: string; failures: number; window_started_at: string };
const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Client } = requireFromServer("pg") as {
  Client: new (options: { connectionString: string }) => {
    connect(): Promise<void>; end(): Promise<void>;
    query(sql: string, values?: unknown[]): Promise<{ rows: Counter[] }>;
  };
};

const lockTest = test.extend<{ lockStaffId: string }>({
  lockStaffId: async ({}, use) => {
    test.skip(!process.env.SEAM_DATABASE_URL, "real lock isolation needs disposable PostgreSQL via SEAM_DATABASE_URL");
    const id = "lock" + randomUUID().replaceAll("-", "");
    // Matches the real loopback peer and default tenant in the seam config.
    // Do not reset the table or unrelated accounts, and retain microseconds.
    const buckets = ["ip:127.0.0.1", `miss:tnt-yorkfx:${id}`];
    const client = new Client({ connectionString: process.env.SEAM_DATABASE_URL! });
    await client.connect();
    try {
      const before = await client.query("SELECT bucket, failures, window_started_at::text FROM signin_failures WHERE bucket = ANY($1::text[])", [buckets]);
      try { await use(id); }
      finally {
        await client.query("BEGIN");
        try {
          await client.query("DELETE FROM signin_failures WHERE bucket = ANY($1::text[])", [buckets]);
          for (const row of before.rows) await client.query("INSERT INTO signin_failures(bucket,failures,window_started_at) VALUES ($1,$2,$3::timestamptz)", [row.bucket, row.failures, row.window_started_at]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    } finally { await client.end(); }
  },
});

const SENTENCE = /Too many tries\. Try again at \d{1,2}:\d{2} (AM|PM)\./;

async function contrastAgainstWhite(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    const match = getComputedStyle(el).color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const channels = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
    const lin = (channel: number) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const L = (rgb: number[]) => 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
    const fg = L(channels);
    const bg = L([255, 255, 255]);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
}

async function openPassword(page: Page, staffId: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByPlaceholder("your-staff-id")).toBeVisible();
  await page.getByPlaceholder("your-staff-id").fill(staffId);
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.locator('input[type="password"]')).toBeVisible();
}

test.describe("locked sign-in", () => {
  for (const width of [360, 390]) {
    lockTest(`the lock ends on screen at ${width}`, async ({ page, lockStaffId }) => {
      await page.clock.install();
      await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
      await openPassword(page, lockStaffId);
      const password = page.locator('input[type="password"]');
      const send = page.getByRole("button", { name: "Sign in" });
      for (let attempt = 0; attempt < 10; attempt++) {
        if (await page.getByText(SENTENCE).isVisible()) break;
        await password.fill("wrong-password-lock");
        const pending = page.waitForResponse(
          (res) => res.url().includes("/api/auth/login/start") && res.request().method() === "POST",
        );
        await send.click();
        await pending;
      }

      const status = page.getByText(SENTENCE);
      await expect(status).toBeVisible();
      expect(await contrastAgainstWhite(status)).toBeGreaterThanOrEqual(4.5);
      expect(await contrastAgainstWhite(page.getByText(/Forgot it\?/))).toBeGreaterThanOrEqual(4.5);
      expect(await contrastAgainstWhite(page.getByText("OS", { exact: true }))).toBeGreaterThanOrEqual(4.5);
      const signIn = page.getByRole("button", { name: "Sign in" });
      await expect(signIn).toBeDisabled();
      await expect(signIn.locator("svg")).toBeVisible();
      expect((await signIn.innerText()).replace(/\s+/g, " ").trim()).toBe("Sign in");
      expect(await signIn.evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
      await expect(page.getByRole("button", { name: /send my code/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^locked$/i })).toHaveCount(0);
      await expect(page.getByText(/Another code/)).toHaveCount(0);
      await expect(page.getByText(/\((EDT|EST|AM|PM)\)/)).toHaveCount(0);
      await expect(page.getByText("We'll email a fresh code to confirm it's you.")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send yourself a reset code" })).toBeVisible();
      for (const name of ["not you?", "Send yourself a reset code", "SHOW"]) {
        const box = await page.getByRole("button", { name }).boundingBox();
        expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
      }

      await page.clock.fastForward(16 * 60 * 1000);
      const unlocked = page.getByRole("button", { name: "Sign in" });
      await expect(unlocked).toBeEnabled();
      expect((await unlocked.innerText()).replace(/\s+/g, " ").trim()).toBe("Sign in");
      await expect(unlocked.locator("svg")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /send my code/i })).toHaveCount(0);
    });
  }

  test("a real cashier can sign in after the lock UI cases", async ({ request }) => {
    const response = await request.post("/api/auth/login", {
      data: { staffId: "m.costa", password: "yorkville" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["set-cookie"]).toContain("cdos_session=");
  });

  test("a password-only cashier signs in", async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 844 });
    await openPassword(page, "m.costa");
    await page.locator('input[type="password"]').fill("yorkville");
    const signIn = page.getByRole("button", { name: "Sign in" });
    await expect(signIn).toBeEnabled();
    expect((await signIn.innerText()).replace(/\s+/g, " ").trim()).toBe("Sign in");
    expect(await signIn.evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
    await expect(page.getByRole("button", { name: /send my code/i })).toHaveCount(0);

    const retryAt = new Date(Date.now() + 60_000).toISOString();
    await page.route("**/api/auth/login/start", (route) => route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: "too_many_attempts", until: "10:42 AM", retryAt, timeZone: "America/Toronto" }),
    }));
    await signIn.click();
    await expect(page.getByText("Too many tries. Try again at 10:42 AM.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();

    await page.clock.fastForward(3 * 60 * 1000);
    const again = page.getByRole("button", { name: "Sign in" });
    await expect(again).toBeEnabled();
    expect((await again.innerText()).replace(/\s+/g, " ").trim()).toBe("Sign in");
    await expect(again.locator("svg")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /send my code/i })).toHaveCount(0);
  });

  test("a password-only cashier is welcomed by name", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPassword(page, "m.costa");
    await expect(page.getByRole("heading", { name: "Welcome back, M. Costa", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Welcome back, M", exact: true })).toHaveCount(0);
  });

  test("a lock with no server time says a few minutes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPassword(page, `notime${Date.now().toString(36)}`);
    await page.route("**/api/auth/login/start", (route) => route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: "too_many_attempts" }),
    }));
    await page.locator('input[type="password"]').fill("wrong-password-lock");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Too many tries. Try again in a few minutes.")).toBeVisible();
    const again = page.getByRole("button", { name: "Try again" });
    await expect(again).toBeEnabled();
    await again.click();
    await expect(page.getByText("Too many tries. Try again in a few minutes.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });

  test("resending a code while locked says the same time", async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 844 });
    let calls = 0;
    await page.route("**/api/auth/login/start", (route) => {
      calls += 1;
      if (calls === 1) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            needsCode: true,
            maskedEmail: "s•••@shop.example",
            user: { id: "sam@shop.example", name: "Sam", role: "teller" },
          }),
        });
      }
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "too_many_attempts", until: "5:04 AM" }),
      });
    });
    await openPassword(page, "sam@shop.example");
    await page.locator('input[type="password"]').fill("wrong-password-lock");
    await page.getByRole("button", { name: /send my code/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    await page.clock.fastForward(121_000);
    await page.getByRole("button", { name: "Resend" }).click();
    await expect(page.getByText("Too many tries. Try again at 5:04 AM.")).toBeVisible();
  });

  test("a 503 says sign-in is having trouble", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPassword(page, `svc${Date.now().toString(36)}`);
    await page.route("**/api/auth/login/start", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "email_unavailable", detail: "Sign-in service error (503)" }),
    }));
    await page.locator('input[type="password"]').fill("wrong-password-lock");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Sign-in is having trouble. Try again in a minute.")).toBeVisible();
  });
});
