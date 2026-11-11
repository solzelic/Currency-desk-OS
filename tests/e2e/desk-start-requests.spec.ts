/* The desk asks the server once for each thing it needs as it starts.

   On the way in the desk asked GET /api/auth/me twice (the resume check
   and the session check, each on its own) and GET /api/rates twice (the
   rate converter's first read, then the desk's own read of the lock). From
   Israel each of those is a round trip of about 240 ms to staging, and on
   the free plan's shared CPU every extra call at start slows the others.

   One of each is enough. What the desk shows does not change: the menu
   bar's rate badge still follows the server's lock, read from that one
   answer. */
import type { Page, Request } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

test.describe.configure({ mode: "serial" });

/* Every GET under /api/ from a reload until three seconds after the desk
   is up. The desk polls, so the network never goes quiet; three seconds
   covers the start, and the converter's next read is a minute away. */
async function startRequests(page: Page): Promise<string[]> {
  const seen: string[] = [];
  const note = (r: Request) => {
    const url = new URL(r.url());
    if (r.method() === "GET" && url.pathname.startsWith("/api/")) seen.push(url.pathname);
  };
  page.on("request", note);
  try {
    await page.reload();
    await landOnDesktop(page);
    await page.waitForTimeout(3_000);
  } finally {
    page.off("request", note);
  }
  return seen;
}
const times = (seen: string[], path: string) => seen.filter((p) => p === path).length;
const setLock = (page: Page, locked: boolean) =>
  page.evaluate(async (on) => (await fetch("/api/rates/lock", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locked: on }),
  })).status, locked);

test("a signed-in desk asks who is signed in once, and reads the board once, as it starts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, "r.haddad");
  const seen = await startRequests(page);
  expect(times(seen, "/api/auth/me"), seen.join("\n")).toBe(1);
  expect(times(seen, "/api/rates"), seen.join("\n")).toBe(1);
});

/* The badge is set from the server's answer, not from what this browser
   last saw: the browser's copy is set to the opposite before each start. */
test("the menu bar still shows the server's lock, read from that one answer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, "r.haddad");
  const badge = page.locator(".tk-badge").first();
  try {
    expect(await setLock(page, true)).toBe(200);
    await page.evaluate(() => localStorage.setItem("yorkfx_rates_locked", "0"));
    const seen = await startRequests(page);
    expect(times(seen, "/api/rates"), seen.join("\n")).toBe(1);
    await expect(badge).toHaveText("LOCKED");
  } finally {
    expect(await setLock(page, false)).toBe(200);
  }
  await page.evaluate(() => localStorage.setItem("yorkfx_rates_locked", "1"));
  const seen = await startRequests(page);
  expect(times(seen, "/api/rates"), seen.join("\n")).toBe(1);
  await expect(badge).toHaveText("HOURLY");
});

test("the sign-in screen asks who is signed in once", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (r.method() === "GET" && url.pathname === "/api/auth/me") seen.push(url.pathname);
  });
  await page.goto("/login");
  await expect(page.locator("#lock")).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(seen).toHaveLength(1);
});
