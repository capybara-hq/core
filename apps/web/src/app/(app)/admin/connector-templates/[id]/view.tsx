"use client";

import { Card, DetailPage, ObjectMark, Stack, Text, versionLabel } from "@capybara-hq/design";
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
import { SetupGuideSection } from "../../../../../components/SetupGuideSection";
import { usePagePath } from "../../../../../components/shell/path";
import { templateGuideIn } from "../../../../../lib/catalog";
import { componentLabel, type PlatformComponent } from "../../../../../lib/components";
import { catalogItemQuery } from "../../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { adminComponentsQuery, componentVersionsQuery } from "../../../../../lib/query/components";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import type { SetupGuideRef } from "../../../../../lib/setup-guides";
import NotFound from "../../../not-found";

const TABS = ["versions", "orgs"] as const;
/** The tabs, and 接入指南 when the template's plugin has a setup guide for it. */
type Tab = (typeof TABS)[number] | "guide";

/**
 * `/admin/connector-templates/[id]` (super admins; spec §9): one platform connector template. Head: its
 * name, version and state; actions 设置范围 (跟随插件 or its own scope, with the impact preview),
 * 停用 / 启用. Tabs 版本 / 组织;
 * one centred column: the full description first, the facts (来自, 归属, 范围, 在用组织) as a
 * KeyValue over the tab. From the query cache: the kind's list (a component
 * not in it is the not-found state) and its versions (a section).
 */
export default function AdminConnectorTemplateView({ id }: { id: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminConnectorTemplateRead id={id} orgId={gate.me.currentOrgId} />;
}

function AdminConnectorTemplateRead({ id, orgId }: { id: string; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents.detail");
  const list = usePageQuery(adminComponentsQuery("connector_template"));
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  if (list.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [
            ...scope,
            { label: "connector-templates", href: "/admin/connector-templates" },
            { label: id },
          ],
          title: "",
          // the plugin's mark keeps its place
          loading: { title: true, avatar: true },
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
  return <AdminConnectorTemplate c={c} orgId={orgId} />;
}

function AdminConnectorTemplate({ c, orgId }: { c: PlatformComponent; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents.detail");
  const label = componentLabel(c, useLocale());
  const [tab, setTab] = useState<Tab>("versions");
  const vq = componentVersionsQuery("connector_template", c.id);
  const versions = useQuery({ ...vq, retryOnMount: retryOnMountOf(vq.queryKey) }).data?.versions;
  const { actions, dialog } = useComponentActions(c, orgId);
  // Its setup guide: the connector-template guide naming it in its item's latest version
  const iq = catalogItemQuery(c.itemId ?? "");
  const item = useQuery({
    ...iq,
    enabled: c.itemId !== null,
    retryOnMount: retryOnMountOf(iq.queryKey),
  }).data;
  const guide = item === undefined ? null : templateGuideIn(item, c.name);
  const tabs: Tab[] = guide !== null ? [...TABS, "guide"] : [...TABS];
  const shown: Tab = tabs.includes(tab) ? tab : "versions";
  return (
    <>
      <DetailPage
        header={{
          path: [
            ...scope,
            { label: "connector-templates", href: "/admin/connector-templates" },
            { label: c.name },
          ],
          // the display name with its plugin's mark; the id stays in the path
          avatar: <ObjectMark size={40} text={label} image={c.icon ?? null} />,
          title: label,
          count: versionLabel(c.version),
          status: <StateBadges c={c} />,
          actions,
        }}
        tabs={{
          label: t("tabsLabel"),
          items: tabs.map((x) => ({ id: x, label: t(`tabs.${x}`) })),
          value: shown,
          onChange: (x) => setTab(x as Tab),
        }}
      >
        <Stack gap={16}>
          {/* The full description, first in the column (the head's line would cut it) */}
          {c.description !== null && c.description !== "" && (
            <Text variant="prose" tone="muted" pre>
              {c.description}
            </Text>
          )}
          <ComponentNotes c={c} />
          <ComponentFacts c={c} />
          {shown === "guide" && guide !== null ? (
            <PlatformGuide guide={guide} />
          ) : shown === "versions" ? (
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

/**
 * 接入指南 (setup guides v2 spec §9.3, decided 2026-11-09): the template's guide as org admins read
 * it, with no org and no target: org and connector names stay as written, and there are no check
 * rows (they need a target) and no drift notice.
 */
function PlatformGuide({ guide }: { guide: SetupGuideRef }) {
  const t = useTranslations("setupGuide");
  return (
    <Card title={t("title")}>
      <Stack gap={16}>
        <Text variant="prose" tone="muted">
          {t("platformHint")}
        </Text>
        <SetupGuideSection orgId="" guide={guide} query={{}} admin />
      </Stack>
    </Card>
  );
}
