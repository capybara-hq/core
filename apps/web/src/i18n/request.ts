import { locale as rootLocale } from "next/root-params";
import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

/**
 * 每个请求的 next-intl 配置：语言取自根布局的 `[locale]` 段（`next/root-params`），
 * 显式传入的 `locale`（如 `getTranslations({ locale })`）优先；非法值回落到默认语言。
 */
export default getRequestConfig(async ({ locale: explicit }) => {
  const candidate: unknown = explicit ?? (await rootLocale());
  const locale = hasLocale(routing.locales, candidate) ? candidate : routing.defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
