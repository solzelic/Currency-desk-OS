/* The shared seam server keeps its real signup throttle. A burst in one
   test must still be refused, without spending the next test's budget. */
import { test, expect, hasLedger } from "./fixtures";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL and the isolated seam server");

function attempt(request: APIRequestContext, n: number, url = "/api/signup") {
  return request.post(url, {
    data: {
      businessName: "Throttle isolation",
      ownerName: "Test Owner",
      email: `isolation-${n}@signup-throttle.example`,
      password: "signup-throttle-test",
      slug: `throttle-isolation-${n}`,
    },
  });
}

test("one test still exhausts the real eight-attempt signup limit", async ({ request }) => {
  /* These addresses were never invited: the request reaches the throttle
     and then stops at the invitation check, without creating any desk. */
  for (let n = 0; n < 8; n++) {
    const response = await attempt(request, n);
    expect(response.status(), await response.text()).toBe(403);
    expect((await response.json()).error).toBe("not_invited");
  }
  const refused = await attempt(request, 8);
  expect(refused.status()).toBe(429);
  expect((await refused.json()).error).toBe("slow_down");
});

test("the next test has its own allowance on the same running server", async ({ request }) => {
  const response = await attempt(request, 9);
  expect(response.status(), await response.text()).toBe(403);
  expect((await response.json()).error).toBe("not_invited");
});

test.describe("a spec with its own server address", () => {
  test.use({ baseURL: "http://separate-server.invalid" });

  test("setup still resets the shared server", async ({ request }, testInfo) => {
    const url = new URL("/api/signup", testInfo.config.webServer!.url!).href;
    const response = await attempt(request, 10, url);
    expect(response.status(), await response.text()).toBe(403);
    expect((await response.json()).error).toBe("not_invited");
  });
});
