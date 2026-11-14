import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// 内部包 exports 里的 "@capybara-hq/source" 条件指向 src，测试直接跑源码而非可能过期的 dist。
// 其余是 Vite 服务端默认条件（设置 conditions 会替换默认值，所以要写全）。
const conditions = ["@capybara-hq/source", "module", "node", "development|production"];

/**
 * `CAPYBARA_TEST_WORKERS` caps vitest's worker pool, so a local run leaves the machine usable
 * (`CAPYBARA_TEST_WORKERS=4 pnpm verify`). Anything that is not a positive integer is ignored,
 * keeping today's behaviour (no cap: one worker per core).
 */
export function maxWorkersFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

const maxWorkers = maxWorkersFromEnv(process.env.CAPYBARA_TEST_WORKERS);

// Kernel test projects. Membership is a checked-in list, not a naming convention: unit tests are
// pure functions (no database, no container, no HTTP server, no queue and no Nest app); container
// tests drive real processes or two replicas. Everything else in packages/kernel/test is
// integration (the default category). See
// docs/superpowers/specs/2026-11-14-test-portfolio-design.md.
const kernelTest = (p: string) => `packages/kernel/test/${p}`;
const unitTests = JSON.parse(
  readFileSync(new URL("./packages/kernel/test/unit-tests.json", import.meta.url), "utf8"),
) as string[];
const containerTests = JSON.parse(
  readFileSync(new URL("./packages/kernel/test/container-tests.json", import.meta.url), "utf8"),
) as string[];

export default defineConfig({
  resolve: { conditions },
  // 服务端（测试）不带 "module"：vitest 会把 ssr 条件原样作为 Node 的 --conditions 传给 worker，
  // 带上它时，Node 原生加载的外部化依赖会被导到 "module" 指向的 esm 构建（@aws-sdk/*、
  // @opentelemetry/api 等，里面有无扩展名导入），加载失败。生产运行时 Node 本来就不用 "module"。
  // 所以也不再需要用 server.deps.inline 把这类包交给 Vite 转换。
  ssr: { resolve: { conditions: conditions.filter((c) => c !== "module") } },
  test: {
    hookTimeout: 120_000,
    // CI 机器负载高：起子进程的双副本测试、每次都算密码哈希的登录测试在 5s 默认值附近超时（非回归），CI 上放宽。
    testTimeout: process.env.CI ? 30_000 : 5_000,
    // Local runs only: a cap for a machine that must stay responsive (see maxWorkersFromEnv). It
    // relies on every project keeping `extends: true` (Vitest 5 errors otherwise).
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    projects: [
      // Node 环境：所有包的 *.test.ts（含 apps/web 的代理路由测试）。
      {
        extends: true,
        test: {
          name: "node",
          include: ["{packages,apps,plugins,tools}/*/test/**/*.test.ts"],
          exclude: [
            "packages/design/**",
            "packages/plugin-client/**",
            "packages/kernel/test/**",
            "**/node_modules/**",
          ],
          // One PostgreSQL + one Valkey per run, handed to workers via env vars: startTestPostgres()
          // creates a database per file on it. CAPYBARA_TEST_NO_SHARED=1 restores per-file containers.
          globalSetup: ["packages/testing/src/global-setup.ts"],
        },
      },
      // Kernel unit tests: pure functions, so no database, no HTTP server, no queue, no app and no
      // globalSetup.
      {
        extends: true,
        test: {
          name: "kernel-unit",
          include: unitTests.map(kernelTest),
          testTimeout: 5_000,
          hookTimeout: 10_000,
        },
      },
      // Kernel integration tests: every kernel test not in the unit or container lists. One
      // PostgreSQL + one Valkey per run via the shared globalSetup.
      {
        extends: true,
        test: {
          name: "kernel-integration",
          include: ["packages/kernel/test/**/*.test.ts"],
          exclude: [...unitTests, ...containerTests].map(kernelTest),
          globalSetup: ["packages/testing/src/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      // Kernel container tests: real processes or two replicas. The long timeouts are an upper
      // bound sized to the category, not a per-test override.
      {
        extends: true,
        test: {
          name: "kernel-container",
          include: containerTests.map(kernelTest),
          globalSetup: ["packages/testing/src/global-setup.ts"],
          testTimeout: 240_000,
          hookTimeout: 300_000,
        },
      },
      // jsdom 环境：设计系统包 @capybara-hq/design 的测试。
      {
        extends: true,
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "design",
          include: ["packages/design/test/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["packages/design/test/setup.ts"],
        },
      },
      // jsdom: @capybara-hq/plugin-client (hooks need a DOM; no containers).
      {
        extends: true,
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "plugin-client",
          include: ["packages/plugin-client/test/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
      // jsdom 环境：apps/web 的组件 / 浏览器端测试（*.test.tsx）。
      {
        extends: true,
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "web",
          include: ["apps/web/test/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["apps/web/test/setup.ts"],
          // next-intl 的 ESM 构建 import "next/navigation"（无扩展名），交给 Vite 解析。
          server: { deps: { inline: ["next-intl", "use-intl"] } },
        },
      },
    ],
  },
});
