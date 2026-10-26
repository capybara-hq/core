import { defineConfig, devices } from "@playwright/test";

/** The catalog server's port: 3100, or CAPYBARA_VISUAL_PORT when another worktree holds it. */
const PORT = process.env.CAPYBARA_VISUAL_PORT ?? "3100";

/**
 * Side-by-side acceptance page (design spec §9.6), a local review tool, not CI:
 * `COMPARE=button,table pnpm --filter @capybara-hq/web compare` screenshots each
 * `/dev/ui/reference/<component>` block and writes apps/web/compare-out/index.html with the
 * reference PNG (docs/design/reference) left and the implementation right, dark then light.
 */
export default defineConfig({
  testDir: "./compare",
  timeout: 300_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `next build && next start -p ${PORT}`,
    url: `http://localhost:${PORT}/zh/dev/ui`,
    env: { CAPYBARA_DEV_UI: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
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
