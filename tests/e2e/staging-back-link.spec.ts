import { expect, test } from "@playwright/test";

/* ============================================================
   Staging only, so on a host whose name says staging: the way back to the
   sign-in page is on every page of the journey, setup included (Sol, 14
   Nov: "I should always be able to go back to that login page"), it stays
   there when a page rebuilds itself (setup does), and it signs out on the
   way so /login shows the sign-in page, not a desk. The host name is
   mapped to this machine, and the staging door's answer is stubbed: the
   test server is not a staging host.
   ============================================================ */
test.use({
  launchOptions: {
    args: ["--host-resolver-rules=MAP cd-staging.test 127.0.0.1"],
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  },
});

for (const path of ["/", "/early-access", "/onboarding/CD-ABCDEF"]) {
  test(`the staging way back to sign-in is on ${path} and stays there`, async ({ page }) => {
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

test("the way back is not drawn on a host that is not staging", async ({ page }) => {
  await page.route("**/api/staging/signin", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) }));
  await page.goto("/early-access");
  await page.waitForTimeout(2000);
  await expect(page.locator("#cd-staging-back")).toHaveCount(0);
});
