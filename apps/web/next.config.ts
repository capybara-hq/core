import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** pnpm monorepo 根目录（依赖都软链到根的 node_modules/.pnpm）。 */
const monorepoRoot = new URL("../..", import.meta.url).pathname;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@capybara-hq/design"],
  turbopack: {
    root: monorepoRoot,
    // 内部包按 "@capybara-hq/source" 条件直接编译源码（与 vitest / tsc 一致）；Turbopack 不支持自定义导出条件，用别名指到源码入口。
    resolveAlias: {
      "@capybara-hq/design/styles.css": "../../packages/design/src/styles/index.css",
      "@capybara-hq/design/theme": "../../packages/design/src/theme.ts",
      "@capybara-hq/design": "../../packages/design/src/index.ts",
    },
  },
  outputFileTracingRoot: monorepoRoot,
  // 第一段的安装表单已由向导取代（否则 /apps/new 会落到应用详情的动态路由）
  redirects: async () => [
    { source: "/:locale(zh|en)/apps/new", destination: "/:locale/apps/install", permanent: false },
  ],
};

export default withNextIntl(nextConfig);
