"use client";

import { DetailPage, Stack, Text, versionLabel } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  ComponentFacts,
  ComponentNotes,
  ComponentOrgs,
  ComponentVersions,
  StateBadges,
  useComponentActions,
} from "../../../../../components/AdminComponents";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { componentDescription, type PlatformComponent } from "../../../../../lib/components";
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
 * one centred column: the full description first, the facts (来自, 归属, 范围, 在用组织) as a
 * KeyValue over the tab. From the query cache: the kind's list (a component
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
        // One column: the facts (a KeyValue of six) over the tab
        loading={{ content: [{ kind: "key-value", rows: 6, keyWidth: "8ch" }, { kind: "list" }] }}
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
  const description = componentDescription(c, useLocale());
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
      >
        <Stack gap={16}>
          {/* The full description, first in the column (the head's line would cut it) */}
          {description !== null && (
            <Text variant="prose" tone="muted" pre>
              {description}
            </Text>
          )}
          <ComponentNotes c={c} />
          <ComponentFacts c={c} />
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
