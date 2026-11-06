"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { ComponentsTable } from "../../../../components/AdminComponents";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { adminComponentsQuery } from "../../../../lib/query/components";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/admin/connector-templates` (super admins; spec §9): every platform connector template of the deployment
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
  const list = usePageQuery(adminComponentsQuery("connector_template"));
  const header = {
    path: [...scope, { label: "connector-templates" }],
    title: t("titles.connector_template"),
    description: t("descriptions.connector_template"),
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  return (
    <ListPage header={header}>
      <ComponentsTable
        kind="connector_template"
        rows={list.kind === "ready" ? list.data.components : null}
      />
    </ListPage>
  );
}
