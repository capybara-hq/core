"use client";

import { useTranslations } from "next-intl";
import { useContext } from "react";
import { canUpdateOrg } from "../lib/org-settings";
import { SessionContext } from "./shell/session";

/**
 * 设置的二级导航：已连接的应用 / 已记住的授权 / 已绑定的 IM 身份（个人）与组织设置、组织插件、模型用途
 * （插件与模型用途只对管理员显示，界面隐藏而已，最终由内核判定）。这些页都归在一级导航「应用」下
 * （见 shell/nav.tsx 的 activeNavOf）。
 */
export function useSettingsNav() {
  const t = useTranslations("connections.nav");
  const session = useContext(SessionContext);
  const admin = session !== null && canUpdateOrg(session.me);
  return [
    { id: "connections", label: t("connections"), href: "/settings/connections" },
    { id: "grants", label: t("grants"), href: "/settings/grants" },
    { id: "identities", label: t("identities"), href: "/settings/identities" },
    { id: "organization", label: t("organization"), href: "/settings/organization" },
    ...(admin
      ? [
          { id: "plugins", label: t("plugins"), href: "/settings/plugins" },
          { id: "models", label: t("models"), href: "/settings/models" },
        ]
      : []),
  ];
}
