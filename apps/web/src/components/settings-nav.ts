"use client";

import { useTranslations } from "next-intl";

/**
 * 设置的二级导航：已连接的应用 / 已记住的授权（个人）与组织设置。这些页都归在一级导航「应用」下
 * （见 shell/nav.tsx 的 activeNavOf）。
 */
export function useSettingsNav() {
  const t = useTranslations("connections.nav");
  return [
    { id: "connections", label: t("connections"), href: "/settings/connections" },
    { id: "grants", label: t("grants"), href: "/settings/grants" },
    { id: "organization", label: t("organization"), href: "/settings/organization" },
  ];
}
