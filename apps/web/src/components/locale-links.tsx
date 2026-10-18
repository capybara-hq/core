"use client";

import { Stack } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "../i18n/navigation";
import { routing } from "../i18n/routing";

/** 认证页（无 App Shell）的语言切换：每种语言一个链接，保持当前路径；当前语言带 aria-current。 */
export function LocaleLinks() {
  const t = useTranslations("common");
  const current = useLocale();
  const pathname = usePathname();
  return (
    <nav aria-label={t("language")}>
      <Stack direction="row" gap={12} justify="center">
        {routing.locales.map((locale) => (
          <Link
            key={locale}
            href={pathname}
            locale={locale}
            hrefLang={locale}
            {...(locale === current ? { "aria-current": "true" as const } : {})}
          >
            {t(`localeName.${locale}`)}
          </Link>
        ))}
      </Stack>
    </nav>
  );
}
