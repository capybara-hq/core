import { defineRouting } from "next-intl/routing";

/** 路由前缀 `/zh`、`/en`，默认 `zh`。 */
export const routing = defineRouting({
  locales: ["zh", "en"],
  defaultLocale: "zh",
});

export type AppLocale = (typeof routing.locales)[number];
