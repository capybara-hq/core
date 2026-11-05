import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { isAppLocale, LOCALE_COOKIE, negotiateLocale, routing } from "./routing";

/**
 * Each request's next-intl config. The language is an explicit `locale` (e.g.
 * `getTranslations({ locale })`), else the `NEXT_LOCALE` cookie, else the browser's
 * Accept-Language, else the default. URLs carry no language, so a server render already has the
 * right one (no client-side switch after hydration).
 */
export default getRequestConfig(async ({ locale: explicit }) => {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isAppLocale(explicit)
    ? explicit
    : isAppLocale(cookie)
      ? cookie
      : (negotiateLocale((await headers()).get("accept-language")) ?? routing.defaultLocale);
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
