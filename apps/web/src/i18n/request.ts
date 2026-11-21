import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { platformMetaQuery } from "../lib/query/app-auth";
import { serverQueryClient } from "../lib/server/query";
import { withProductName } from "./product";
import { isAppLocale, LOCALE_COOKIE, negotiateLocale, routing } from "./routing";
// The platform meta read goes through the server transport.
import "../lib/server/register";

/**
 * The platform name (`platform.name`) from the public meta, read once per request (the root layout
 * reads the same query for the title); null when it is unset or the kernel cannot be read (the
 * kernel-starting page), and the messages then say the built-in name.
 */
async function platformName(): Promise<string | null> {
  try {
    return (await serverQueryClient().fetchQuery({ ...platformMetaQuery(), retry: false })).name;
  } catch {
    return null;
  }
}

/**
 * Each request's next-intl config. The language is an explicit `locale` (e.g.
 * `getTranslations({ locale })`), else the `NEXT_LOCALE` cookie, else the browser's
 * Accept-Language, else the default. URLs carry no language, so a server render already has the
 * right one (no client-side switch after hydration). Every `{product}` in the messages is the
 * platform name ({@link withProductName}), on the server and in the client provider alike.
 */
export default getRequestConfig(async ({ locale: explicit }) => {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isAppLocale(explicit)
    ? explicit
    : isAppLocale(cookie)
      ? cookie
      : (negotiateLocale((await headers()).get("accept-language")) ?? routing.defaultLocale);
  const [catalog, name] = await Promise.all([
    import(`../../messages/${locale}.json`).then((m) => m.default),
    platformName(),
  ]);
  return { locale, messages: withProductName(catalog, name) };
});
