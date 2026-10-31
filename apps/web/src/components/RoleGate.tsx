"use client";

import { StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { usePathname } from "../i18n/navigation";
import { myRole, type OrgRole, roleAtLeast } from "../lib/members";
import { OrgGate } from "./OrgGate";
import { activeNavOf } from "./shell/nav";
import { usePagePath } from "./shell/path";
import { useSession } from "./shell/session";

/** The role a page needs: an org role, or `enterprise` for the admin console. */
export type Need = Exclude<OrgRole, "guest"> | "enterprise";

/**
 * The one no-access state (web-order spec §9, R2): what the page is, which role it needs and
 * who to ask; never a retry. Drawn by {@link RoleGate} and the admin console's AdminGate.
 */
export function NoAccess({ need }: { need: Need }) {
  const t = useTranslations();
  const pathname = usePathname();
  const enterprise = need === "enterprise";
  const scope = usePagePath(enterprise ? "admin" : "org");
  const nav = activeNavOf(pathname);
  const page = enterprise
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
      ask={enterprise ? t("roles.noAccess.askEnterprise") : t("roles.noAccess.askOrg")}
    />
  );
}

/**
 * A page that needs at least `min` in the current org (R2): below it the page is the no-access
 * state and loads nothing; otherwise `children(orgId, role)`. Wraps OrgGate (no current org →
 * its own state). Cosmetic: the kernel stays the authority.
 */
export function RoleGate({
  min,
  children,
}: {
  min: Exclude<OrgRole, "guest">;
  children: (orgId: string, role: OrgRole) => ReactNode;
}) {
  return <OrgGate>{(orgId) => <RoleGateInner min={min}>{children}</RoleGateInner>}</OrgGate>;
}

function RoleGateInner({
  min,
  children,
}: {
  min: Exclude<OrgRole, "guest">;
  children: (orgId: string, role: OrgRole) => ReactNode;
}) {
  const { me } = useSession();
  const role = myRole(me);
  if (me.currentOrgId === null || role === undefined || !roleAtLeast(role, min)) {
    return <NoAccess need={min} />;
  }
  return children(me.currentOrgId, role);
}
