"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { ComponentCard, useOwnerFilter } from "../../../../../components/AdminComponents";
import { adminItemTabs } from "../../../../../components/admin-item-tabs";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { adminComponentsQuery } from "../../../../../lib/query/components";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import NotFound from "../../../not-found";

/**
 * `/admin/agents/templates` (super admins; spec §9, ruling P4-17): every agent template of the
 * deployment as cards, under the header tabs 智能体 / 模板, with the owner filter 全部 / 平台 / 组织创建: source · owner · scope · v on each, the
 * primary 查看 (its detail) and ⋯ with 对其他组织显示, 设置范围 and 停用 / 启用. From the query
 * cache (the layout prefetched the list and the orgs on a first load).
 */
export default function AdminAgentTemplatesView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminAgentTemplates orgId={gate.me.currentOrgId} />;
}

function AdminAgentTemplates({ orgId }: { orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents");
  const ti = useTranslations("adminItems.tabs");
  const list = usePageQuery(adminComponentsQuery("agent_template"));
  const owner = useOwnerFilter(list.kind === "ready" ? list.data.components : null);
  const header = {
    path: [...scope, { label: "agents", href: "/admin/agents" }, { label: "templates" }],
    title: t("titles.agent_template"),
    description: t("descriptions.agent_template"),
    ...adminItemTabs("agents", "templates", { items: ti("agents"), templates: ti("templates") }),
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const common = { variant: "cards" as const, listLabel: t("titles.agent_template") };
  if (list.kind === "loading")
    return <ListPage header={header} filters={owner.filters} {...common} loading={{ rows: 6 }} />;
  const rows = owner.rows ?? [];
  return (
    <ListPage
      header={header}
      filters={owner.filters}
      {...common}
      {...(rows.length === 0
        ? {
            empty: {
              // nothing at all, or nothing under the open tab
              text:
                list.data.components.length === 0
                  ? t("empty.agent_template")
                  : t("emptyTab.agent_template"),
            },
          }
        : {})}
    >
      {rows.map((c) => (
        <ComponentCard key={c.id} c={c} orgId={orgId} />
      ))}
    </ListPage>
  );
}
