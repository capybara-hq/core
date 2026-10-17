"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "../i18n/navigation";
import { routing } from "../i18n/routing";

/** 切换界面语言（保持当前路径）。 */
export function LocaleSwitcher() {
  const t = useTranslations("common");
  const current = useLocale();
  const pathname = usePathname();
  return (
    <nav aria-label={t("language")} className="locales">
      {routing.locales.map((locale) =>
        locale === current ? (
          <strong key={locale}>{t(`localeName.${locale}`)}</strong>
        ) : (
          <Link key={locale} href={pathname} locale={locale}>
            {t(`localeName.${locale}`)}
          </Link>
        ),
      )}
    </nav>
  );
}
