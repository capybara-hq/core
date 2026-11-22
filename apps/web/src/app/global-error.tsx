"use client";

import "@capybara-hq/design/styles.css";
import { parseTheme, THEME_COOKIE } from "@capybara-hq/design/theme";
import { NextIntlClientProvider } from "next-intl";
import { useSyncExternalStore } from "react";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { DesignRoot } from "../components/design-root";
import { ErrorFrame } from "../components/ErrorFrame";
import { StaticTheme } from "../components/static-theme";
import { withProductName } from "../i18n/product";
import {
  type AppLocale,
  isAppLocale,
  LOCALE_COOKIE,
  negotiateLocale,
  routing,
} from "../i18n/routing";
import { useBrandCookie } from "../lib/use-brand-cookie";

const noSubscribe = () => () => {};

function cookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** The language the root layout would have picked: the cookie, else the browser's. */
function clientLocale(): AppLocale {
  const chosen = cookie(LOCALE_COOKIE);
  if (isAppLocale(chosen)) return chosen;
  return negotiateLocale(navigator.languages.join(",")) ?? routing.defaultLocale;
}

const clientTheme = () => parseTheme(cookie(THEME_COOKIE));

/**
 * The root layout itself failed (web-SSR spec §5): this replaces it, so it brings its own document,
 * styles, language, scheme, theme (the brand cookie, theme brand coverage spec §5) and providers,
 * then the same error page as the route groups. It cannot read the platform meta, so a `{product}`
 * in its messages says the built-in name.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  const locale = useSyncExternalStore(noSubscribe, clientLocale, () => routing.defaultLocale);
  const theme = useSyncExternalStore(noSubscribe, clientTheme, () => parseTheme(undefined));
  const brand = useBrandCookie();
  return (
    <html lang={locale} data-theme={theme}>
      <body>
        <NextIntlClientProvider
          locale={locale}
          messages={withProductName(locale === "zh" ? zh : en, null)}
        >
          <DesignRoot locale={locale}>
            <StaticTheme brand={brand}>
              <ErrorFrame reset={reset} />
            </StaticTheme>
          </DesignRoot>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
