"use client";

import { useTranslations } from "next-intl";

/**
 * The platform name (`platform.name`, else the built-in one) in a component: `common.appName` is
 * `{product}`, which the request config fills for every message (`i18n/product.ts`), so the
 * server render and the client agree without another read.
 */
export function useProductName(): string {
  return useTranslations("common")("appName");
}
