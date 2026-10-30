import "@capybara-hq/design/styles.css";
// 服务端组件只能引入无 React 状态的子路径（主入口含 createContext，属客户端模块）。
import { parseTheme, THEME_COOKIE } from "@capybara-hq/design/theme";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DesignRoot } from "../components/design-root";
import { isAppLocale, routing } from "../i18n/routing";

/**
 * The body font (Regular): the same file the design system's fonts.css `@font-face` points at, so
 * the bundler emits one content-hashed `/_next/static/media/…woff2` and the preload hits the cache.
 */
const regularFont = new URL(
  "../../../../packages/design/src/fonts/SarasaMonoSC-Regular.subset.woff2",
  import.meta.url,
);
// 只取路径与查询串（服务端的 import.meta.url 是 file:// 地址；查询串保留部署 ID 等后缀）
const REGULAR_FONT = `${regularFont.pathname}${regularFont.search}`;

export async function generateMetadata() {
  const t = await getTranslations("metadata");
  return { title: t("title"), description: t("description") };
}

/**
 * The root layout. The language comes from next-intl's request config (the `NEXT_LOCALE` cookie or
 * Accept-Language, see `i18n/request.ts`); the theme from the `cb-theme` cookie (tokens are defined
 * only under `:root[data-theme]`, so data-theme is always written; an invalid value falls back to
 * dark). Provides the next-intl and design system contexts.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const requested = await getLocale();
  const locale = isAppLocale(requested) ? requested : routing.defaultLocale;
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang={locale} data-theme={theme}>
      <head>
        <link
          rel="preload"
          href={REGULAR_FONT}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <NextIntlClientProvider>
          <DesignRoot locale={locale}>{children}</DesignRoot>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
