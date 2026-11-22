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
  // Shard by test, not by file (`--shard` cuts the test list into equal counts): the specs still
  // run one at a time (one worker), since they share one stack, the `admin` account, the org Acme
  // and platform state. A file whose tests depend on each other marks itself serial
  // (`test.describe.serial` / `describe.configure({ mode: "serial" })`), which keeps it in one shard.
  fullyParallel: true,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...(process.env.CAPYBARA_E2E_BASE_URL !== undefined && {
      baseURL: process.env.CAPYBARA_E2E_BASE_URL,
    }),
    trace: "retain-on-failure",
    // the UI language follows Accept-Language when no NEXT_LOCALE cookie is set: the specs read zh
    locale: "zh-CN",
  },
  // setup 项目在全新内核上跑初始化向导（初始化页的断言只在 setup.spec.ts）；其余用例依赖它先跑完，
  // 再用 e2e/support/sign-in.ts 登录，不依赖文件名排序。
  projects: [
    { name: "setup", testMatch: /setup\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium",
      testIgnore: /setup\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
