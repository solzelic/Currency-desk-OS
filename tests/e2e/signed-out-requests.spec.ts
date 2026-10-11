/* A signed-out desk used to ask /api/auth/me twice and then the ledger
   and the rate board, all before anyone had a session. Those calls
   came back 401, or 200 for the public board, and none of them were
   for a person who had signed in. Boot asks who you are once. Nothing
   else under /api/ until a session exists. */
import type { Request } from "@playwright/test";
import { test, expect } from "./fixtures";

function apiPath(req: Request): string | null {
  const path = new URL(req.url()).pathname;
  return path.startsWith("/api/") ? path : null;
}

test("signed out, the desk asks who you are once and loads nothing else", async ({ page }) => {
  for (const path of ["/login", "/app"]) {
    const hits: string[] = [];
    const onRequest = (req: Request) => {
      const p = apiPath(req);
      if (p) hits.push(p);
    };
    page.on("request", onRequest);
    await page.goto(path);
    await expect(page.locator("#lock")).toBeVisible();
    await expect.poll(() => hits.filter((h) => h === "/api/auth/me").length, { timeout: 10_000 }).toBe(1);
    /* The second auth check and the ledger reads used to leave in the
       same tick as the first. A short settle is enough to see them,
       and short enough that the 60s board poll cannot sneak in. */
    await page.waitForTimeout(750);
    expect(hits.filter((h) => h === "/api/auth/me"), path).toEqual(["/api/auth/me"]);
    expect(hits.filter((h) => h !== "/api/auth/me"), path).toEqual([]);
    page.off("request", onRequest);
  }
});
