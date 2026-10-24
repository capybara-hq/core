"use client";

import { useTranslations } from "next-intl";
import { useContext } from "react";
import { myRole, roleAtLeast } from "../lib/members";
import { canUpdateOrg } from "../lib/org-settings";
import { SessionContext } from "./shell/session";

/**
 * The settings' second-level navigation: connected connectors / remembered approvals / linked IM
 * identities (personal), then org settings, members, the org's extensions, installed plugins and
 * model purposes (members from the member role up; extensions, plugins and model purposes for
 * admins only; this only hides them, the kernel decides). These pages all sit under the
 * "Connectors" top-level item (see activeNavOf in shell/nav.tsx).
 */
export function useSettingsNav() {
  const t = useTranslations("connections.nav");
  const session = useContext(SessionContext);
  const admin = session !== null && canUpdateOrg(session.me);
  const member = session !== null && roleAtLeast(myRole(session.me), "member");
  return [
    { id: "connections", label: t("connections"), href: "/settings/connections" },
    { id: "grants", label: t("grants"), href: "/settings/grants" },
    { id: "identities", label: t("identities"), href: "/settings/identities" },
    { id: "organization", label: t("organization"), href: "/settings/organization" },
    ...(member ? [{ id: "members", label: t("members"), href: "/settings/members" }] : []),
    ...(admin
      ? [
          { id: "extensions", label: t("extensions"), href: "/settings/extensions" },
          { id: "plugins", label: t("plugins"), href: "/settings/plugins" },
          { id: "models", label: t("models"), href: "/settings/models" },
        ]
      : []),
  ];
}
