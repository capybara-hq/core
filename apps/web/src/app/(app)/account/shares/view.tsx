"use client";

import { SettingsPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { SharesTable } from "../../../../components/SharesTable";
import { ACCOUNT_HOME, useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { useWorkspace } from "../../../../lib/query/workspace";

/**
 * `/account/shares` (SettingsPage; every member): the file links the person shared, with Revoke.
 * From the query cache (the layout prefetched it on a first load).
 */
export default function MySharesView() {
  const ws = useWorkspace({ setup: "step" });
  if (ws.kind !== "ok") return null;
  return <MyShares orgId={ws.orgId} />;
}

function MyShares({ orgId }: { orgId: string }) {
  const scope = usePagePath("home");
  const t = useTranslations("shares.list");
  const nav = useAccountNav();
  return (
    <SettingsPage
      header={{
        path: [...scope, { label: "account", href: ACCOUNT_HOME }, { label: "shares" }],
        title: t("mineTitle"),
        description: t("mineDescription"),
      }}
      nav={nav}
      activeNav="myShares"
    >
      <SharesTable orgId={orgId} scope="mine" />
    </SettingsPage>
  );
}
