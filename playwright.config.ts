import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: "/opt/homebrew/opt/node@22/bin/npm run build && /opt/homebrew/opt/node@22/bin/npm run preview -- --port 4174",
    url: "http://127.0.0.1:4174/frontend.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  use: {
    baseURL: "http://127.0.0.1:4174/frontend.html",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
