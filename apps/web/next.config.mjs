import { fileURLToPath } from "node:url";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** pnpm monorepo 根目录（依赖都软链到根的 node_modules/.pnpm）。 */
const monorepoRoot = new URL("../..", import.meta.url).pathname;

/**
 * Dev only: the hosts besides localhost that may load the dev server's scripts and HMR
 * (`CAPYBARA_WEB_DEV_ORIGINS`, comma-separated, e.g. `192.168.3.52,dev.lan`). `next dev` blocks
 * other origins, so a page opened over a LAN address renders without its client JS. `next build` /
 * `next start` ignore `allowedDevOrigins`.
 */
const devOrigins = (process.env.CAPYBARA_WEB_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev indicator would cover the sidebar's account row.
  devIndicators: false,
  // Dev only: keep every compiled page for the whole `next dev` session. Next's default disposes a
  // page after 60 s without a visit (beyond the 5 most recent), so a later visit compiles it again,
  // and a client navigation that lands on such a recompile can hang without an answer (an e2e
  // flake: the nav click to /agents never left /). Each route now compiles once, on its first visit.
  onDemandEntries: { maxInactiveAge: 24 * 60 * 60 * 1000, pagesBufferLength: 1000 },
  ...(devOrigins.length > 0 && { allowedDevOrigins: devOrigins }),
  transpilePackages: ["@capybara-hq/design"],
  webpack(config, { dev }) {
    if (dev) {
      config.resolve.conditionNames = [
        "@capybara-hq/source",
        ...(config.resolve.conditionNames ?? ["..."]),
      ];
      // Expand layered imports before Next's legacy CSS loader reads them as media queries.
      const designStyles = fileURLToPath(
        new URL("../../packages/design/src/styles/index.css", import.meta.url),
      );
      config.module.rules.push({
        enforce: "pre",
        test: (resource) => resource === designStyles,
        use: [
          {
            loader: fileURLToPath(
              new URL("./scripts/design-css-imports-loader.cjs", import.meta.url),
            ),
          },
        ],
      });
    }
    return config;
  },
  turbopack: {
    root: monorepoRoot,
    // 内部包按 "@capybara-hq/source" 条件直接编译源码（与 vitest / tsc 一致）；Turbopack 不支持自定义导出条件，用别名指到源码入口。
    resolveAlias: {
      "@capybara-hq/design/styles.css": "../../packages/design/src/styles/index.css",
      "@capybara-hq/design/theme": "../../packages/design/src/theme.ts",
      "@capybara-hq/design/fixtures": "../../packages/design/src/fixtures/index.ts",
      "@capybara-hq/design/reference": "../../packages/design/src/reference/index.ts",
      "@capybara-hq/design": "../../packages/design/src/index.ts",
    },
  },
  outputFileTracingRoot: monorepoRoot,
  // 第一段的安装表单已由向导取代（否则 /apps/new 会落到应用详情的动态路由）
  redirects: async () => [
    // The new conversation is the home at `/` (maintainer decision 2026-11-07, acceptance): the old
    // `/chat` (exactly; `/chat/<id>` stays) moves there for good. The query passes through.
    { source: "/chat", destination: "/", permanent: true },
    { source: "/:locale(zh|en)/apps/new", destination: "/:locale/apps/install", permanent: false },
    // Personal settings moved from /settings/* to /account/* (old links, bookmarks, return URLs)
    ...["connections", "grants", "identities"].flatMap((page) => [
      { source: `/settings/${page}`, destination: `/account/${page}`, permanent: true },
      {
        source: `/:locale(zh|en)/settings/${page}`,
        destination: `/:locale/account/${page}`,
        permanent: true,
      },
    ]),
    // 智能体模板 became the 模板 tab of /agents and its detail the template page (ruling P4-14).
    // Temporary: /agent-templates never shipped in a release, so no browser should cache the move.
    { source: "/agent-templates", destination: "/agents?tab=templates", permanent: false },
    {
      source: "/:locale(zh|en)/agent-templates",
      destination: "/:locale/agents?tab=templates",
      permanent: false,
    },
    { source: "/agent-templates/:id", destination: "/agents/templates/:id", permanent: false },
    {
      source: "/:locale(zh|en)/agent-templates/:id",
      destination: "/:locale/agents/templates/:id",
      permanent: false,
    },
    // The template page's parent has no page of its own: its path segment means the 模板 tab.
    { source: "/agents/templates", destination: "/agents?tab=templates", permanent: false },
    {
      source: "/:locale(zh|en)/agents/templates",
      destination: "/:locale/agents?tab=templates",
      permanent: false,
    },
  ],
};

export default withNextIntl(nextConfig);
