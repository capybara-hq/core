import { defineConfig, devices } from "@playwright/test";

/**
 * Renders the reference set (docs/design/reference/src) to docs/design/reference/<block>-<theme>.png:
 * `pnpm --filter @capybara-hq/web reference:render`. The committed PNGs come only from the
 * reference-update workflow (mcr.microsoft.com/playwright:v1.64.1-noble, the visual job's image).
 */
export default defineConfig({
  testDir: "./reference",
  timeout: 120_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3200",
  },
  webServer: {
    command: "node reference/serve.mjs",
    url: "http://127.0.0.1:3200/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 2,
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
