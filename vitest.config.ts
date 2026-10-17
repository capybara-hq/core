import { defineConfig } from "vitest/config";

// 内部包 exports 里的 "@capybara-hq/source" 条件指向 src，测试直接跑源码而非可能过期的 dist。
// 其余是 Vite 服务端默认条件（设置 conditions 会替换默认值，所以要写全）。
const conditions = ["@capybara-hq/source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    hookTimeout: 120_000,
    // 上面的 "module" 条件会让外部化依赖 @opentelemetry/api（@anthropic-ai/sdk 的依赖）解析到
    // 无扩展名导入的 esm 构建，Node 原生加载失败；把这两个包交给 Vite 转换。
    // 生产运行时 Node 不用 "module" 条件，不受影响。
    server: { deps: { inline: ["@anthropic-ai/sdk", "@opentelemetry/api"] } },
    projects: [
      // Node 环境：所有包的 *.test.ts（含 apps/web 的代理路由测试）。
      {
        extends: true,
        test: { name: "node", include: ["{packages,apps,plugins,tools}/*/test/**/*.test.ts"] },
      },
      // jsdom 环境：apps/web 的组件 / 浏览器端测试（*.test.tsx）。
      {
        extends: true,
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "web",
          include: ["apps/web/test/**/*.test.tsx"],
          environment: "jsdom",
          // next-intl 的 ESM 构建 import "next/navigation"（无扩展名），交给 Vite 解析。
          server: { deps: { inline: ["next-intl", "use-intl"] } },
        },
      },
    ],
  },
});
