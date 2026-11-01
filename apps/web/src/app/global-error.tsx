"use client";

import "@capybara-hq/design/styles.css";
import { parseTheme, THEME_COOKIE } from "@capybara-hq/design/theme";
import { NextIntlClientProvider } from "next-intl";
import { useSyncExternalStore } from "react";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";
import { DesignRoot } from "../components/design-root";
import { ErrorFrame } from "../components/ErrorFrame";
import {
  type AppLocale,
  isAppLocale,
  LOCALE_COOKIE,
  negotiateLocale,
  routing,
} from "../i18n/routing";

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
 * styles, language, theme and providers, then the same error page as the route groups.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  const locale = useSyncExternalStore(noSubscribe, clientLocale, () => routing.defaultLocale);
  const theme = useSyncExternalStore(noSubscribe, clientTheme, () => parseTheme(undefined));
  return (
    <html lang={locale} data-theme={theme}>
      <body>
        <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
          <DesignRoot locale={locale}>
            <ErrorFrame reset={reset} />
          </DesignRoot>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
