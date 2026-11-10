"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { ComponentsTable, useOwnerFilter } from "../../../../../components/AdminComponents";
import { adminItemTabs } from "../../../../../components/admin-item-tabs";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { adminComponentsQuery } from "../../../../../lib/query/components";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import NotFound from "../../../not-found";

/**
 * `/admin/connectors/templates` (super admins; spec §9): every platform connector template of the deployment
 * with 来自, 归属, 范围, 版本 and the orgs using it; each opens its detail. From the query cache
 * (the layout prefetched the list and the orgs on a first load).
 */
export default function AdminConnectorTemplatesView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminConnectorTemplates />;
}

function AdminConnectorTemplates() {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents");
  const ti = useTranslations("adminItems.tabs");
  const list = usePageQuery(adminComponentsQuery("connector_template"));
  const owner = useOwnerFilter(list.kind === "ready" ? list.data.components : null);
  const header = {
    path: [...scope, { label: "connectors", href: "/admin/connectors" }, { label: "templates" }],
    title: t("titles.connector_template"),
    description: t("descriptions.connector_template"),
    ...adminItemTabs("connectors", "templates", {
      items: ti("connectors"),
      templates: ti("templates"),
    }),
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  return (
    <ListPage header={header} filters={owner.filters}>
      <ComponentsTable kind="connector_template" rows={owner.rows} />
    </ListPage>
  );
}
