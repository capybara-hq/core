"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import {
  ComponentsTable,
  useOwnerTabs,
  usePlatformDefaultTheme,
} from "../../../../components/AdminComponents";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { adminComponentsQuery } from "../../../../lib/query/components";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/admin/themes` (super admins; themes spec §10): every theme of the deployment with 来自, 归属,
 * 范围, 版本 and the orgs using it, the platform default marked; each opens its detail. From the
 * query cache (the layout prefetched the list, the orgs and the settings on a first load).
 */
export default function AdminThemesView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminThemes />;
}

function AdminThemes() {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents");
  const list = usePageQuery(adminComponentsQuery("theme"));
  const tabs = useOwnerTabs(list.kind === "ready" ? list.data.components : null);
  const platformDefault = usePlatformDefaultTheme();
  const header = {
    path: [...scope, { label: "themes" }],
    title: t("titles.theme"),
    description: t("descriptions.theme"),
    tabs: tabs.items,
    activeTab: tabs.active,
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  return (
    <ListPage header={header}>
      <ComponentsTable kind="theme" rows={tabs.rows} platformDefault={platformDefault} />
    </ListPage>
  );
}
