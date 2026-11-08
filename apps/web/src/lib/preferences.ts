"use client";

import { applyTheme, type PreferenceBarProps, parseTheme, type Theme } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useResolvedTheme } from "../components/theme-root";
import { useRouter } from "../i18n/navigation";
import { isAppLocale, localeCookie, routing } from "../i18n/routing";

/**
 * The language and theme controls (the sidebar's and the auth pages' PreferenceBar). Choosing a
 * language writes the `NEXT_LOCALE` cookie and re-renders on the server (the URL stays the same);
 * choosing a theme writes `cb-theme` and repaints at once. Under a single-scheme UI theme (the
 * resolved theme of the enclosing `ThemeRoot`: the org's in the workspace, the platform's on the
 * auth pages) there is no scheme to choose: `theme` is absent, so no toggle is drawn anywhere
 * (themes spec §10).
 */
export function usePreferences(): PreferenceBarProps {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const singleScheme = useResolvedTheme()?.singleScheme ?? null;
  const [theme, setTheme] = useState<Theme>("dark");
  // the server rendered <html data-theme> from the cookie; read it after hydration
  useEffect(() => {
    setTheme(parseTheme(document.documentElement.dataset.theme));
  }, []);
  return {
    language: {
      label: t("common.language"),
      value: locale,
      options: routing.locales.map((l) => ({ value: l, label: t(`common.localeName.${l}`) })),
      onChange: (next) => {
        if (!isAppLocale(next) || next === locale) return;
        // biome-ignore lint/suspicious/noDocumentCookie: synchronous write before the refresh; the Cookie Store API is async and not everywhere
        document.cookie = localeCookie(next);
        router.refresh();
      },
    },
    ...(singleScheme === null && {
      theme: {
        label: t("common.theme"),
        value: theme,
        lightLabel: t("common.themeLight"),
        darkLabel: t("common.themeDark"),
        onChange: (next: Theme) => {
          applyTheme(next);
          setTheme(next);
        },
      },
    }),
  };
}
