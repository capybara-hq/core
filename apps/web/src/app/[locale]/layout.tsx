import "@capybara-hq/design/styles.css";
// 服务端组件只能引入无 React 状态的子路径（主入口含 createContext，属客户端模块）。
import { parseTheme, THEME_COOKIE } from "@capybara-hq/design/theme";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DesignRoot } from "../../components/design-root";
import { routing } from "../../i18n/routing";

type Params = Promise<{ locale: string }>;

/**
 * 正文字体（Regular）的地址：与设计系统 base.css 的 `@font-face` 引用同一文件，由打包器按内容哈希
 * 输出到同一个 `/_next/static/media/…woff2`，预加载后 CSS 直接命中缓存。
 */
const regularFont = new URL(
  "../../../../../packages/design/src/fonts/SarasaMonoSC-Regular.subset.woff2",
  import.meta.url,
);
// 只取路径与查询串（服务端的 import.meta.url 是 file:// 地址；查询串保留部署 ID 等后缀）
const REGULAR_FONT = `${regularFont.pathname}${regularFont.search}`;

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Params }) {
  const { locale } = await params;
  const t = await getTranslations({
    locale: hasLocale(routing.locales, locale) ? locale : routing.defaultLocale,
    namespace: "metadata",
  });
  return { title: t("title"), description: t("description") };
}

/**
 * 根布局：校验语言段；主题取自 Cookie `cb-theme`（token 只定义在 `:root[data-theme]` 下，
 * 因此总是写入 data-theme，非法值回落深色）；提供 next-intl 与设计系统的上下文。
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Params;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
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
