import { defineConfig, devices } from "@playwright/test";

/**
 * 端到端测试（`pnpm --filter @capybara-hq/web e2e`）：不在默认的 `pnpm test` 中运行。
 * 全局准备（e2e/global-setup.ts）起容器、内核与 Web 层，并把 Web 地址写入
 * `CAPYBARA_E2E_BASE_URL`；worker 进程重新加载本配置时继承该变量。
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...(process.env.CAPYBARA_E2E_BASE_URL !== undefined && {
      baseURL: process.env.CAPYBARA_E2E_BASE_URL,
    }),
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
