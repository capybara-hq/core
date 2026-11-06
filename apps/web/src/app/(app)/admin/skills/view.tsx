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
 * `/admin/skills` (super admins; spec §9): every platform skill of the deployment
 * with 来自, 归属, 范围, 版本 and the orgs using it; each opens its detail. From the query cache
 * (the layout prefetched the list and the orgs on a first load).
 */
export default function AdminSkillsView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminSkills />;
}

function AdminSkills() {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents");
  const list = usePageQuery(adminComponentsQuery("skill"));
  const header = {
    path: [...scope, { label: "skills" }],
    title: t("titles.skill"),
    description: t("descriptions.skill"),
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  return (
    <ListPage header={header}>
      <ComponentsTable kind="skill" rows={list.kind === "ready" ? list.data.components : null} />
    </ListPage>
  );
}
