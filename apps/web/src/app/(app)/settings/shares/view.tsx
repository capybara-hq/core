"use client";

import { SettingsPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { NoAccess } from "../../../../components/NoAccess";
import { SharesTable } from "../../../../components/SharesTable";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useWorkspace } from "../../../../lib/query/workspace";

/**
 * `/settings/shares` (SettingsPage, group 组织; org admins): every shared file link of the org with
 * Revoke. From the query cache (the layout prefetched it on a first load).
 */
export default function SharesSettingsView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Shares orgId={ws.orgId} />;
}

function Shares({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("shares.list");
  const nav = useOrgSettingsNav();
  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "settings", href: "/settings/organization" },
          { label: "shares" },
        ],
        title: t("title"),
        description: t("description"),
      }}
      nav={nav}
      activeNav="shares"
    >
      <SharesTable orgId={orgId} scope="all" />
    </SettingsPage>
  );
}
