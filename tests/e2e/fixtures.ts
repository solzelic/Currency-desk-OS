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

   THE VERSIONS HAVE TO AGREE, EXACTLY

   Those <script> tags carry an SRI `integrity` hash. The browser hashes
   whatever comes back and blocks it if the digest differs — so serving
   7.29.7 in answer to a request for 7.29.0 does not merely serve the
   wrong file, it serves nothing at all. Babel never loads, none of the
   JSX on the page ever compiles, and the panel comes up as a black
   rectangle with one line in the console. That is a genuinely horrible
   thing to debug from a CI log, so the substitution below refuses to
   guess: if node_modules and the page disagree, the test says which
   two versions and where to fix it.
   ============================================================ */
/* Playwright runs from the directory holding its config, which is the
   repo root. import.meta is not available here — the runner compiles
   these to CommonJS. */
const ROOT = process.cwd();
/* What we are willing to answer for, and the file inside each package
   that unpkg would have served. */
const VENDOR: Record<string, true> = { react: true, "react-dom": true, "@babel/standalone": true };
const UNPKG = /unpkg\.com\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/;

function installedVersion(pkg: string): string {
  return JSON.parse(readFileSync(path.join(ROOT, "node_modules", pkg, "package.json"), "utf8")).version;
}

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.route("**unpkg.com/**", (route) => {
      const url = route.request().url();
      const m = UNPKG.exec(url);
      if (!m || !VENDOR[m[1]!]) return route.abort();
      const [, pkg, want, file] = m as unknown as [string, string, string, string];

      const have = installedVersion(pkg);
      if (have !== want) {
        throw new Error(
          `${pkg}: the page asks for ${want}, node_modules has ${have}.\n` +
            `These are served from disk and the page pins them with an SRI hash, so a\n` +
            `mismatch is blocked by the browser and the page renders nothing at all.\n` +
            `Pin "${pkg}": "${want}" in package.json, or update the <script> tag and its\n` +
            `integrity hash in 'CurrencyDesk OS.html' and 'admin.html' to ${have}.`,
        );
      }
      return route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: readFileSync(path.join(ROOT, "node_modules", pkg, file), "utf8"),
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

/* ============================================================
   SEAM HELPERS

   A cash figure exists in two places during any of these tests: on the
   screen, and in the ledger. The whole point of a seam test is to read
   both and assert they say the same thing — a server test and a browser
   test, run side by side, will each pass while the two disagree.

   These run only when SEAM_DATABASE_URL names a real PostgreSQL, because
   the embedded database has no ledger routes at all.
   ============================================================ */
export const hasLedger = !!process.env.SEAM_DATABASE_URL;


/**
 * Get from wherever the page is to the desk itself.
 *
 * An owner is asked where they are working before the desk opens — "Owner
 * access — every branch, any till" — because they are the one person the
 * product cannot infer a drawer for. A teller or a manager has one, so they
 * land straight on the desktop.
 *
 * Exported because ANY reload puts an owner back on that screen, and a
 * helper that reloads mid-test (to open a till, to top up a drawer) leaves
 * the caller on the chooser with no error to explain why the next click
 * found nothing. Call this after a reload.
 */
export async function landOnDesktop(page: Page): Promise<void> {
  const chooser = page.getByRole("heading", { name: /Where are you working/i });
  const desktop = page.getByText(/Rate Board/i).first();
  /* Waits for whichever arrives. `isVisible()` does NOT wait — it answers
     about this instant — so asking it straight after a reload answered "no
     chooser" while the chooser was still rendering. */
  await Promise.race([
    chooser.waitFor({ state: "visible", timeout: 45_000 }),
    desktop.waitFor({ state: "visible", timeout: 45_000 }),
  ]);
  if (!(await chooser.isVisible())) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    /* A free drawer by preference: the chooser labels each till with who is
       on it, and a session outlives a browser context, so the obvious first
       till is often one this same person already holds. */
    const free = page.getByRole("button", { name: /· free$/ });
    const anyTill = page.getByRole("button", { name: /^(Till \d|Wholesale)/ });
    await ((await free.count()) ? free.first() : anyTill.first()).click();
    await page.getByRole("button", { name: /^Open workspace$/ }).click();
    /* Somebody may already be on that drawer. The desk asks before taking
       it, and confirming is what a person does. */
    const takeOver = page.getByRole("button", { name: /^Take over till$/ });
    if (await takeOver.isVisible({ timeout: 3_000 }).catch(() => false)) await takeOver.click();
    if (await desktop.isVisible({ timeout: 15_000 }).catch(() => false)) return;
  }
  await desktop.waitFor({ state: "visible", timeout: 45_000 });
}

/** Sign in at the desk and land on the OS, whoever they are. */
export async function signInAtDesk(page: Page, staffId = "a.singh"): Promise<void> {
  await page.goto("/app");
  const status = await page.evaluate(async (id) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: id, password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    return r.status;
  }, staffId);
  if (status !== 200) throw new Error(`desk sign-in failed: ${status}`);
  await page.reload();

  await landOnDesktop(page);
}

/** Ask the ledger directly, from inside the signed-in page. */
export function ledger(page: Page) {
  const get = (url: string) => page.evaluate((u) => fetch(u).then((r) => r.json()), url);
  return {
    till: () => get("/api/ledger/till-balances").then((r: any) => r.balances ?? {}),
    session: () => get("/api/ledger/till-session").then((r: any) => r.session ?? null),
    vault: () => get("/api/ledger/vault"),
    /* Put the desk in a known state through its own endpoints rather than
       fixture SQL — setup that lies about how the product works is setup
       that stops catching the product breaking. */
    async ensureOpeningBalances(balances: Record<string, string>) {
      return page.evaluate(async (b) => {
        const r = await fetch("/api/ledger/opening-balances", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ balances: b }),
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      }, balances);
    },
  };
}

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
