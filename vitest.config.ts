import { defineConfig } from "vitest/config";

// 内部包 exports 里的 "@capybara-hq/source" 条件指向 src，测试直接跑源码而非可能过期的 dist。
// 其余是 Vite 服务端默认条件（设置 conditions 会替换默认值，所以要写全）。
const conditions = ["@capybara-hq/source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  // 服务端（测试）不带 "module"：vitest 会把 ssr 条件原样作为 Node 的 --conditions 传给 worker，
  // 外部化的 CJS 依赖（如 @aws-sdk/client-s3 的 dist-cjs）再 require 子包时会被导到其 dist-es
  // （无扩展名导入），Node 原生加载失败。生产运行时 Node 本来就不用 "module" 条件。
  ssr: { resolve: { conditions: conditions.filter((c) => c !== "module") } },
  test: {
    hookTimeout: 120_000,
    // CI 机器负载高：起子进程的双副本测试、每次都算密码哈希的登录测试在 5s 默认值附近超时（非回归），CI 上放宽。
    testTimeout: process.env.CI ? 30_000 : 5_000,
    // 上面的 "module" 条件会让外部化依赖 @opentelemetry/api（@anthropic-ai/sdk 的依赖）解析到
    // 无扩展名导入的 esm 构建，Node 原生加载失败；把这两个包交给 Vite 转换。
    // 生产运行时 Node 不用 "module" 条件，不受影响。
    server: { deps: { inline: ["@anthropic-ai/sdk", "@opentelemetry/api"] } },
    projects: [
      // Node 环境：所有包的 *.test.ts（含 apps/web 的代理路由测试）。
      {
        extends: true,
        test: {
          name: "node",
          include: ["{packages,apps,plugins,tools}/*/test/**/*.test.ts"],
          exclude: ["packages/design/**", "**/node_modules/**"],
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
