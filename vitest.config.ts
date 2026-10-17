import { defineConfig } from "vitest/config";

// 内部包 exports 里的 "@capybara-hq/source" 条件指向 src，测试直接跑源码而非可能过期的 dist。
// 其余是 Vite 服务端默认条件（设置 conditions 会替换默认值，所以要写全）。
const conditions = ["@capybara-hq/source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["{packages,apps,plugins,tools}/*/test/**/*.test.ts"],
    hookTimeout: 120_000,
  },
});
