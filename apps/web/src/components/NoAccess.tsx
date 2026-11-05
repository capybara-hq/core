"use client";

import { StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { usePathname } from "../i18n/navigation";
import type { OrgRole } from "../lib/members";
import { activeNavOf } from "./shell/nav";
import { usePagePath } from "./shell/path";

/** The role a page needs: an org role, or `superAdmin` for the admin console. */
export type Need = Exclude<OrgRole, "guest"> | "superAdmin";

/**
 * The one no-access state (web-order spec §9, R2): what the page is, which role it needs and
 * who to ask; never a retry. Drawn by the gates' `noAccess` result (`useWorkspace()`, `useAdmin()`).
 */
export function NoAccess({ need }: { need: Need }) {
  const t = useTranslations();
  const pathname = usePathname();
  const superAdmin = need === "superAdmin";
  const scope = usePagePath(superAdmin ? "admin" : "org");
  const nav = activeNavOf(pathname);
  const page = superAdmin
    ? t("nav.admin")
    : nav !== "" && !nav.startsWith("ext:") && nav !== "overview"
      ? t(`nav.${nav}`)
      : t("roles.noAccess.title");
  const role = t(`roles.need.${need}`);
  return (
    <StatusPage
      header={{ path: scope, title: page }}
      kind="no-access"
      title={t("roles.noAccess.title")}
      description={t("roles.noAccess.description", { page, role })}
      need={role}
      ask={superAdmin ? t("roles.noAccess.askSuperAdmin") : t("roles.noAccess.askOrg")}
    />
  );
}
