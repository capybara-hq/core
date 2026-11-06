"use client";

import { DetailPage, Stack, Text, versionLabel } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  ComponentInspector,
  ComponentNotes,
  ComponentOrgs,
  ComponentVersions,
  StateBadges,
  useComponentActions,
} from "../../../../../components/AdminComponents";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import type { PlatformComponent } from "../../../../../lib/components";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { adminComponentsQuery, componentVersionsQuery } from "../../../../../lib/query/components";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import NotFound from "../../../not-found";

const TABS = ["versions", "orgs"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/skills/[id]` (super admins; spec §9): one platform skill. Head: its
 * name, version and state; actions 设置范围 (跟随插件 or its own scope, with the impact preview),
 * 停用 / 启用, 上传新版本 (a new version on its own, spec §7.2). Tabs 版本 / 组织;
 * the inspector holds 来自, 归属, 范围, 在用组织. From the query cache: the kind's list (a component
 * not in it is the not-found state) and its versions (a section).
 */
export default function AdminSkillView({ id }: { id: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminSkillRead id={id} orgId={gate.me.currentOrgId} />;
}

function AdminSkillRead({ id, orgId }: { id: string; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents.detail");
  const list = usePageQuery(adminComponentsQuery("skill"));
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  if (list.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "skills", href: "/admin/skills" }, { label: id }],
          title: "",
        }}
        tabs={{
          label: t("tabsLabel"),
          items: TABS.map((x) => ({ id: x, label: t(`tabs.${x}`) })),
          value: "versions",
          onChange: () => {},
        }}
        loading={{ inspector: { rows: 6, keyWidth: "8ch" }, content: [{ kind: "list" }] }}
      />
    );
  }
  const c = list.data.components.find((x) => x.id === id);
  if (c === undefined) return <NotFound />;
  return <AdminSkill c={c} orgId={orgId} />;
}

function AdminSkill({ c, orgId }: { c: PlatformComponent; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents.detail");
  const [tab, setTab] = useState<Tab>("versions");
  const vq = componentVersionsQuery("skill", c.id);
  const versions = useQuery({ ...vq, retryOnMount: retryOnMountOf(vq.queryKey) }).data?.versions;
  const { actions, dialog } = useComponentActions(c, orgId);
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "skills", href: "/admin/skills" }, { label: c.name }],
          title: c.name,
          count: versionLabel(c.version),
          status: <StateBadges c={c} />,
          actions,
        }}
        tabs={{
          label: t("tabsLabel"),
          items: TABS.map((x) => ({ id: x, label: t(`tabs.${x}`) })),
          value: tab,
          onChange: (x) => setTab(x as Tab),
        }}
        inspectorTitle={c.name}
        inspector={<ComponentInspector c={c} />}
      >
        <Stack gap={12}>
          <ComponentNotes c={c} />
          {c.description !== null && c.description !== "" && (
            <Text variant="prose" tone="muted">
              {c.description}
            </Text>
          )}
          {tab === "versions" ? (
            <ComponentVersions versions={versions ?? null} />
          ) : (
            <ComponentOrgs c={c} />
          )}
        </Stack>
      </DetailPage>
      {dialog}
    </>
  );
}
