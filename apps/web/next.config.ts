import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** pnpm monorepo 根目录（依赖都软链到根的 node_modules/.pnpm）。 */
const monorepoRoot = new URL("../..", import.meta.url).pathname;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@capybara-hq/design"],
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
};

export default withNextIntl(nextConfig);
