import { defineConfig, devices } from "@playwright/test";

/** The catalog server's port: 3100, or CAPYBARA_VISUAL_PORT when another worktree holds it. */
const PORT = process.env.CAPYBARA_VISUAL_PORT ?? "3100";

/**
 * 截图回归（`pnpm --filter @capybara-hq/web visual`）：对 `/dev/ui` 目录页截图并与基准逐像素比对。
 * 入库的基准只在 Docker 镜像 `mcr.microsoft.com/playwright:v<@playwright/test 版本>-noble` 中生成
 * （CI job `visual` 与 workflow `visual-update` 用同一镜像）；本地 darwin 截图不入库。
 */
export default defineConfig({
  testDir: "./visual",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0, animations: "disabled" },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `next build && next start -p ${PORT}`,
    url: `http://localhost:${PORT}/zh/dev/ui`,
    env: { CAPYBARA_DEV_UI: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
