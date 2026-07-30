import { test as base, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/* ============================================================
   Shared machinery for the end-to-end walks.

   REACT COMES FROM DISK, NOT FROM unpkg

   Both the OS and the panel load React and Babel from a CDN at runtime.
   That is fine in a browser and wrong in a test: a CDN hiccup would fail
   the build for a reason that has nothing to do with the change, and in
   a sandboxed runner the request may not leave at all. The same versions
   are in node_modules, so they are served from there. What is being
   tested is our code, not unpkg's uptime.
   ============================================================ */
/* Playwright runs from the directory holding its config, which is the
   repo root. import.meta is not available here — the runner compiles
   these to CommonJS. */
const ROOT = process.cwd();
const VENDOR: Record<string, string> = {
  "react@18.3.1/umd/react.development.js": "react/umd/react.development.js",
  "react-dom@18.3.1/umd/react-dom.development.js": "react-dom/umd/react-dom.development.js",
  "@babel/standalone@7.29.0/babel.min.js": "@babel/standalone/babel.min.js",
};

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.route("**unpkg.com/**", (route) => {
      const url = route.request().url();
      const hit = Object.keys(VENDOR).find((k) => url.includes(k));
      if (!hit) return route.abort();
      return route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: readFileSync(path.join(ROOT, "node_modules", VENDOR[hit]!), "utf8"),
      });
    });
    /* Tailwind's CDN build is a nicety the OS degrades without, and it is
       not what any of this is testing. */
    await page.route("**cdn.tailwindcss.com**", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
    /* Fonts. Same reasoning, and a blocked font request would otherwise
       show up as a console error in every run. */
    await page.route("**fonts.googleapis.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }));

    await use(page);
  },
});

export const expect = test.expect;

/* Sign in as the platform operator. The panel's own form takes an email
   address and the seeded owner is a staff id, so this goes through the
   API the form posts to — the session cookie is what the panel reads. */
export async function signInAsOperator(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.waitForTimeout(500);
  const status = await page.evaluate(async () => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    return r.status;
  });
  if (status !== 200) throw new Error(`operator sign-in failed: ${status}`);
}

/* Wait for a Babel-compiled page to have actually rendered. These pages
   compile in the browser, so "loaded" and "showing anything" are several
   hundred milliseconds apart and the gap moves with machine speed. */
export async function rendered(page: Page, text: string | RegExp): Promise<void> {
  await page.getByText(text).first().waitFor({ state: "visible", timeout: 45_000 });
}

/* The six-digit code, read off the server's output the way a person does
   while email is not configured: the send is written out rather than
   delivered. The log is tee'd to a file by the webServer command, so
   there is no test-only endpoint and no backdoor in the product.

   Polled, because the send and the write race on a fast machine. */
const SERVER_LOG = path.join(ROOT, "test-results", "server.log");
export async function codeFor(email: string, since = 0): Promise<string> {
  for (let i = 0; i < 60; i++) {
    let log = "";
    try { log = readFileSync(SERVER_LOG, "utf8").slice(since); } catch { /* not written yet */ }
    const line = log.split("\n").reverse().find((l) => l.includes(`to=${email}`) && /\b\d{6}\b/.test(l));
    const m = line?.match(/\b(\d{6})\b/);
    if (m) return m[1]!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no verification code for ${email} in the server output`);
}
export function logSize(): number {
  try { return readFileSync(SERVER_LOG, "utf8").length; } catch { return 0; }
}
