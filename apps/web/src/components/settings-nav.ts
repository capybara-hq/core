"use client";

import { useTranslations } from "next-intl";
import { useContext } from "react";
import { myRole, roleAtLeast } from "../lib/members";
import { canUpdateOrg } from "../lib/org-settings";
import { SessionContext } from "./shell/session";

type NavGroup = { group: string; items: { id: string; label: string; href: string }[] };

/**
 * The organization settings' second-level navigation (`/settings/*`): Organization [General,
 * Members, Models, Service tokens] and Capabilities [Sandbox] (plugins and extensions are the
 * workspace's 插件 and 扩展 pages). Members see
 * General, Members and Sandbox (read-only); the rest is for admins; guests never open these pages. This only hides items,
 * the kernel decides. Groups without items are dropped.
 */
export function useOrgSettingsNav(): NavGroup[] {
  const t = useTranslations("connections.nav");
  const session = useContext(SessionContext);
  const admin = session !== null && canUpdateOrg(session.me);
  const member = session !== null && roleAtLeast(myRole(session.me), "member");
  const groups: NavGroup[] = [
    {
      group: t("groupOrg"),
      items: [
        { id: "organization", label: t("general"), href: "/settings/organization" },
        ...(member ? [{ id: "members", label: t("members"), href: "/settings/members" }] : []),
        ...(admin ? [{ id: "models", label: t("models"), href: "/settings/models" }] : []),
        // org.tokens.manage: admins
        ...(admin ? [{ id: "tokens", label: t("tokens"), href: "/settings/tokens" }] : []),
      ],
    },
    {
      group: t("groupCapabilities"),
      items: [{ id: "sandbox", label: t("sandbox"), href: "/settings/sandbox" }],
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** The personal settings' navigation (`/account/*`): one group. */
export function useAccountNav(): NavGroup[] {
  const t = useTranslations("connections.nav");
  return [
    {
      group: t("groupPersonal"),
      items: [
        { id: "preferences", label: t("preferences"), href: "/account/preferences" },
        { id: "connections", label: t("connections"), href: "/account/connections" },
        { id: "grants", label: t("grants"), href: "/account/grants" },
        { id: "identities", label: t("identities"), href: "/account/identities" },
      ],
    },
  ];
}
