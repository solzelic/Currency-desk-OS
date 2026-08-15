import { defineConfig, devices } from "@playwright/test";

/* ============================================================
   End-to-end, against what actually ships.

   This used to boot the Vite app and open frontend.html — an
   application production never builds and never serves. Every run was
   green and none of it touched the code a customer loads.

   So it boots the real server, configured the way Render configures it:
   the compiled OS at /app, the built marketing pages at /, the panel at
   /admin. In-memory Postgres so a run leaves nothing behind, and rate
   syncing off so no test depends on a rate provider being up.
   ============================================================ */
const PORT = 4173;

export default defineConfig({
  testDir: "./tests/e2e",
  /* One worker. These walk a shared funnel — a desk opening changes what
     the panel shows — and a flaky suite is worse than a slow one. */
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },

  webServer: {
    /* Tee'd to a file so a test can read the verification code out of it,
       which is exactly what a person does when email is not configured:
       the send is written to the server's output instead of delivered. No
       test-only endpoint, no backdoor in the product. */
    command:
      "mkdir -p test-results && cd server && npx tsx src/index.ts 2>&1 | tee ../test-results/server.log",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      /* The same shape Render runs: repo root as the static dir, the
         uncompiled shell named in STATIC_INDEX, the built site at the
         front. The server still prefers web/app when that output is
         present — that is what a customer loads. */
      STATIC_DIR: "..",
      STATIC_INDEX: "CurrencyDesk OS.html",
      SITE_INDEX: "web/index.html",
      /* A database that exists only for this run — unless a real PostgreSQL
         is offered for the seam suite.

         The ledger routes only register when a database URL is configured
         (`app.ts`), so with the embedded database this server has NO LEDGER
         AT ALL. That is why every cash defect in this project survived a
         green end-to-end run: the suite walked the desk with the book torn
         out. Point SEAM_DATABASE_URL at a real PostgreSQL and the server
         comes up in the shape Render runs — one database holding both the
         application tables and the ledger — so a test can drive the screen
         and then ask the ledger whether it agrees. Left unset, everything
         below behaves exactly as before. */
      DATABASE_URL: process.env.SEAM_DATABASE_URL ?? "",
      PGLITE_MEMORY: "1",
      SEED_PASSWORD: "yorkville",
      PLATFORM_ADMIN_EMAILS: "j.masri",
      /* No provider calls. Rates stay put, and email is written to the
         log — which is also where these tests read a confirmation code
         from, exactly as a person would read it off the server output. */
      RATES_SYNC: "off",
    },
  },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    /* CI downloads its own browser. Some sandboxes ship one already and
       would otherwise refuse to run because the build number differs from
       what this Playwright expects — point PW_CHROMIUM at it there. */
    ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}),
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
