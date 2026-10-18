"use client";

import { useTranslations } from "next-intl";

/** 个人设置的二级导航：已连接的应用 / 已记住的授权。 */
export function usePersonalSettingsNav() {
  const t = useTranslations("connections.nav");
  return [
    { id: "connections", label: t("connections"), href: "/settings/connections" },
    { id: "grants", label: t("grants"), href: "/settings/grants" },
  ];
}
