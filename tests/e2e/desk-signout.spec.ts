/* Sign out ends the server session (issue #794).

   The desk's Sign out used to reset the page and stop. The httpOnly
   session cookie stayed valid, so reloading or reopening /app went
   straight back to the station chooser and the desk with no PIN, and
   /api/auth/me still answered 200. A phone had no Sign out at all: the
   Session menu lives in the desktop menu bar, which a phone hides.

   Each walk presses the real control, then asks the server. The cookie
   the browser held before is replayed on its own, so a cleared cookie
   cannot pass for a revoked session. Lock desk is not touched here: it
   keeps the session behind the PIN on purpose.

   With a ledger (SEAM_DATABASE_URL) the till the desk was on is read
   before and after. Signing out does not close, hand over or release
   it on the book: the till belongs to whoever counted it. */
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import { screenshotPath } from "./screenshot-path";

const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;
type Size = (typeof SIZES)[number];

const OWED = "You're signed out on this screen. CurrencyDesk couldn't confirm it with the server yet and will keep trying. This desk won't reopen here without a sign-in.";

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function atDesk(page: Page, size: Size): Promise<string> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await signInAtDesk(page);
  await dismissTour(page);
  const cookie = (await page.context().cookies()).find((c) => c.name === "cdos_session");
  if (!cookie) throw new Error("the desk has no session cookie after sign-in");
  return cookie.value;
}

/* The control a person presses: the Session menu on a wide screen, the
   profile menu in the phone header on a phone. */
async function pressSignOut(page: Page, size: Size, menuOpen?: () => Promise<void>): Promise<void> {
  if (size.name === "phone") {
    await expect(page.locator("#menubar")).toBeHidden();
    await page.locator(".phone-head .mb-acct").click();
    const row = page.locator(".phone-head .acct-menu").getByRole("button", { name: "Sign out" });
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= size.width).toBe(true);
    if (menuOpen) await menuOpen();
    await row.click();
    return;
  }
  await page.getByTitle("Session menu").click();
  const row = page.locator("#menubar .mb-menu").getByRole("button", { name: "Sign out" });
  await expect(row).toBeVisible();
  if (menuOpen) await menuOpen();
  await row.click();
}

function logoutPosted(page: Page) {
  return page.waitForResponse((r) => r.url().endsWith("/api/auth/logout") && r.request().method() === "POST");
}

async function meStatus(page: Page): Promise<number> {
  return page.evaluate(() => fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => r.status));
}

async function replayed(request: APIRequestContext, token: string): Promise<number> {
  const r = await request.get("/api/auth/me", { headers: { cookie: `cdos_session=${token}` } });
  return r.status();
}

/* The sign-in page, and nothing of the desk behind it. The desk would
   have arrived by now: the boot asks /api/auth/me before it routes. */
async function onSignIn(page: Page): Promise<void> {
  await expect(page.getByPlaceholder("your-staff-id")).toBeVisible();
  await expect(page.locator("#desktop .win.show")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Where are you working/i })).toHaveCount(0);
  await expect(page.getByTitle("Session menu")).toHaveCount(0);
}

/* After a reload the boot asks /api/auth/me. While a sign-out is owed it
   does not ask at all: it sends the revoke again ("revoke"), even when
   that request is about to fail. */
async function reopen(page: Page, how: "reload" | "goto", signal: "me" | "revoke" = "me"): Promise<void> {
  const asked = signal === "me"
    ? page.waitForResponse((r) => r.url().endsWith("/api/auth/me"))
    : page.waitForRequest((r) => r.url().endsWith("/api/auth/logout") && r.method() === "POST");
  if (how === "reload") await page.reload();
  else await page.goto("/app");
  await asked;
  /* resume() routes as soon as /me answers; give it the same beat a
     person would before deciding the sign-in page is what stayed. */
  await page.waitForTimeout(750);
}

/* Once the entrance animations have finished. Looping ones (a pulse, a
   spinner) never finish and are left running. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: screenshotPath(testInfo, name) });
}

async function tillOf(page: Page, workspace: string | null) {
  return page.evaluate(async (ws) => {
    const r = await fetch("/api/ledger/till-session", { headers: ws ? { "x-workspace-id": ws } : {} });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, session: (body as { session?: unknown }).session ?? null };
  }, workspace);
}

for (const size of SIZES) {
  test(`Sign out ends the server session at ${size.width}`, async ({ page, request }, testInfo) => {
    const token = await atDesk(page, size);
    expect(await meStatus(page)).toBe(200);
    const workspace = hasLedger
      ? await page.evaluate(() => (window as any).CDOS?.Backend?.getWorkspace?.() ?? null)
      : null;
    const tillBefore = hasLedger ? await tillOf(page, workspace) : null;
    await shot(page, testInfo, `desk-signout-${size.width}-desk.png`);

    const posted = logoutPosted(page);
    await pressSignOut(page, size, () => shot(page, testInfo, `desk-signout-${size.width}-menu.png`));
    expect((await posted).status()).toBe(200);
    await onSignIn(page);
    await expect(page.getByText(OWED)).toHaveCount(0);
    await shot(page, testInfo, `desk-signout-${size.width}-signed-out.png`);

    expect(await meStatus(page)).toBe(401);
    /* the server forgot the session, not only the browser */
    expect(await replayed(request, token)).toBe(401);

    await reopen(page, "reload");
    await onSignIn(page);
    expect(await meStatus(page)).toBe(401);

    await reopen(page, "goto");
    await onSignIn(page);
    expect(await meStatus(page)).toBe(401);
    await shot(page, testInfo, `desk-signout-${size.width}-reopened.png`);

    if (hasLedger) {
      const back = await page.evaluate(async () => {
        const r = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ staffId: "a.singh", password: "yorkville", tenantId: "tnt-yorkfx" }),
        });
        return r.status;
      });
      expect(back).toBe(200);
      const tillAfter = await tillOf(page, workspace);
      expect(tillAfter.status).toBe(tillBefore!.status);
      expect(tillAfter.session).toEqual(tillBefore!.session);
    }
  });
}

/* The revoke does not land: the network is gone, or the server refuses.
   The person still leaves the desk (on a shared counter an open desk is
   the worse outcome), the page says the server has not confirmed it,
   and a reload does not reopen the desk on the cookie that is still
   live. When the server can be reached again the revoke is sent. */
for (const failure of ["offline", "refused"] as const) {
  test(`a Sign out the server does not confirm (${failure}) never reopens the desk`, async ({ page, request }, testInfo) => {
    const size = SIZES[0];
    const token = await atDesk(page, size);
    await page.route("**/api/auth/logout", (route) =>
      failure === "offline" ? route.abort("internetdisconnected") : route.fulfill({ status: 503, body: "" }));

    await pressSignOut(page, size);
    await onSignIn(page);
    await expect(page.getByText(OWED)).toBeVisible();
    await shot(page, testInfo, `desk-signout-${failure}-owed.png`);
    /* honest: the server session is still live until the revoke lands */
    expect(await replayed(request, token)).toBe(200);

    /* still unreachable: the reload sends the revoke again and stays out */
    let meAsked = 0;
    page.on("request", (r) => { if (r.url().endsWith("/api/auth/me")) meAsked += 1; });
    await reopen(page, "reload", "revoke");
    await onSignIn(page);
    await expect(page.getByText(OWED)).toBeVisible();
    expect(meAsked).toBe(0);

    await page.unroute("**/api/auth/logout");
    const posted = logoutPosted(page);
    await reopen(page, "reload", "revoke");
    expect((await posted).status()).toBe(200);
    await onSignIn(page);
    await expect(page.getByText(OWED)).toHaveCount(0);
    expect(await meStatus(page)).toBe(401);
    expect(await replayed(request, token)).toBe(401);
  });
}

test("the network coming back sends the owed revoke without a reload", async ({ page, request }) => {
  const size = SIZES[0];
  const token = await atDesk(page, size);
  await page.route("**/api/auth/logout", (route) => route.abort("internetdisconnected"));
  await pressSignOut(page, size);
  await expect(page.getByText(OWED)).toBeVisible();

  await page.unroute("**/api/auth/logout");
  const posted = logoutPosted(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect((await posted).status()).toBe(200);
  await expect(page.getByText(OWED)).toHaveCount(0);
  expect(await replayed(request, token)).toBe(401);
});

/* While the save and the revoke are in flight the desk is gone from
   under the person's hands, the screen says so, and pressing again does
   not send a second revoke. */
test("Sign out is pending once, and a second press sends nothing more", async ({ page }, testInfo) => {
  const size = SIZES[0];
  await atDesk(page, size);
  let posts = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/api/auth/logout", async (route) => {
    posts += 1;
    await held;
    await route.continue();
  });

  await page.getByTitle("Session menu").click();
  const row = page.locator("#menubar .mb-menu").getByRole("button", { name: "Sign out" });
  await row.dblclick();
  await expect(page.getByRole("status").filter({ hasText: "Signing out…" })).toBeVisible();
  await expect(page.getByTitle("Session menu")).toHaveCount(0);
  await expect(page.locator("#desktop .win.show")).toHaveCount(0);
  await shot(page, testInfo, "desk-signout-pending.png");

  const posted = logoutPosted(page);
  release();
  expect((await posted).status()).toBe(200);
  await onSignIn(page);
  expect(posts).toBe(1);
  expect(await meStatus(page)).toBe(401);
});

/* The desk lock keeps the session: it is the quick way back for the
   same person at a shared counter. Its own Sign out is a full sign-out. */
test("Lock desk keeps the session, and the lock's Sign out ends it", async ({ page, request }) => {
  const size = SIZES[0];
  const token = await atDesk(page, size);
  await page.getByTitle("Session menu").click();
  await page.locator("#menubar .mb-menu").getByRole("button", { name: "Lock desk" }).click();
  await expect(page.getByText("Desk locked")).toBeVisible();
  expect(await replayed(request, token)).toBe(200);

  let posts = 0;
  page.on("request", (r) => { if (r.url().endsWith("/api/auth/logout") && r.method() === "POST") posts += 1; });
  const posted = logoutPosted(page);
  await page.getByRole("button", { name: "Sign out" }).dblclick();
  expect((await posted).status()).toBe(200);
  await onSignIn(page);
  expect(posts).toBe(1);
  expect(await replayed(request, token)).toBe(401);
  await reopen(page, "reload");
  await onSignIn(page);
});
