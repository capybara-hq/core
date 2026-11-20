import "@capybara-hq/design/styles.css";
// A server component imports only the stateless subpaths (the main entry holds createContext, a
// client module).
import { ShellEnvironmentScript } from "@capybara-hq/design/shell-environment";
import { PAGE_BACKGROUND, parseTheme, THEME_COOKIE } from "@capybara-hq/design/theme";
import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DesignRoot } from "../components/design-root";
import { QueryProvider } from "../components/QueryProvider";
import { isAppLocale, routing } from "../i18n/routing";
import type { PlatformMeta } from "../lib/app-auth";
import { NONCE_HEADER } from "../lib/headers";
import { platformMetaQuery } from "../lib/query/app-auth";
import { serverQueryClient } from "../lib/server/query";
import { parseTimeZone, TIME_ZONE_COOKIE } from "../lib/time";
import { platformIconsMetadata } from "../lib/web-manifest";
// Server components' loaders (`apiFetch`) reach the kernel through the server transport.
import "../lib/server/register";

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

/**
 * The viewport (mobile layout spec §7.1, §7.5): edge to edge (`viewport-fit=cover`, the design
 * pads by the safe areas through `--cb-inset-*`), Chromium on Android shrinks the layout viewport
 * for the keyboard (`resizes-content`; iOS ignores it and keeps the AppShell's visualViewport
 * path), and the browser chrome takes the page's background per scheme. Pinch zoom stays: no
 * `maximum-scale`, no `user-scalable`.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PAGE_BACKGROUND.light },
    { media: "(prefers-color-scheme: dark)", color: PAGE_BACKGROUND.dark },
  ],
};

/**
 * The document's title, the iOS web app title, and the page icons follow the deployment (mobile
 * layout spec §10.2): `platform.name` ("Capybara" unset) and the platform icon (the web's set when
 * none is uploaded, or the kernel cannot be read). The manifest link comes from `app/manifest.ts`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");
  let meta: PlatformMeta | null = null;
  try {
    meta = await serverQueryClient().fetchQuery({ ...platformMetaQuery(), retry: false });
  } catch {
    // an unreachable kernel: the defaults
  }
  const name = meta?.name ?? t("title");
  return {
    title: name,
    description: t("description"),
    appleWebApp: { capable: true, title: name, statusBarStyle: "black-translucent" },
    icons: platformIconsMetadata(meta),
  };
}

/**
 * The root layout. The language comes from next-intl's request config (the `NEXT_LOCALE` cookie or
 * Accept-Language, see `i18n/request.ts`); the theme from the `cb-theme` cookie (tokens are defined
 * only under `:root[data-theme]`, so data-theme is always written; an invalid value falls back to
 * dark); the clock server-rendered times are written with (`ServerClock`) from the request's time
 * and the `cb-tz` cookie. Provides the next-intl and design system contexts. The Shell environment
 * script (mobile layout spec §9.3) comes first in `<head>`, with the request's CSP nonce, so a
 * native shell's attributes are on `<html>` before the first paint.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const requested = await getLocale();
  const locale = isAppLocale(requested) ? requested : routing.defaultLocale;
  const jar = await cookies();
  // the proxy's fresh CSP nonce (`x-nonce`); none when the proxy did not run (then no CSP either)
  const nonce = (await headers()).get(NONCE_HEADER) ?? "";
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  // The render's clock: server-rendered times hydrate with it (the viewer's zone once the browser
  // has written it to the cookie, the server's before)
  const clock = {
    now: Date.now(),
    timeZone:
      parseTimeZone(jar.get(TIME_ZONE_COOKIE)?.value) ??
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  // suppressHydrationWarning: browser extensions (a page translator, a dark-mode helper) and the
  // Shell environment script (`data-shell`, the `--cb-shell-*` properties) add attributes to
  // <html> before React hydrates. It covers this element's own attributes only;
  // lang and data-theme are decided here from the request, so the server and client agree.
  return (
    <html lang={locale} data-theme={theme} suppressHydrationWarning>
      <head>
        <ShellEnvironmentScript nonce={nonce} />
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
          <DesignRoot locale={locale} clock={clock}>
            <QueryProvider>{children}</QueryProvider>
          </DesignRoot>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
