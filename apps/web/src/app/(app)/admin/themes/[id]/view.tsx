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
  usePlatformDefaultTheme,
} from "../../../../../components/AdminComponents";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import {
  componentDescription,
  componentName,
  type PlatformComponent,
} from "../../../../../lib/components";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { adminComponentsQuery, componentVersionsQuery } from "../../../../../lib/query/components";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import NotFound from "../../../not-found";

const TABS = ["versions", "orgs"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/themes/[id]` (super admins; themes spec §10): one theme. Head: its name, version and
 * state (平台默认主题 when it is the platform default); actions 设置范围 (跟随插件 or its own scope,
 * with the impact preview) and 停用 / 启用; a theme has no upload of its own (it comes with its
 * plugin). Tabs 版本 / 组织, the facts as a KeyValue over the tab. From the query cache: the
 * themes (one not in it is the not-found state), its versions and the settings (sections).
 */
export default function AdminThemeView({ id }: { id: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminThemeRead id={id} orgId={gate.me.currentOrgId} />;
}

function AdminThemeRead({ id, orgId }: { id: string; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents.detail");
  const list = usePageQuery(adminComponentsQuery("theme"));
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  if (list.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "themes", href: "/admin/themes" }, { label: id }],
          title: "",
        }}
        tabs={{
          label: t("tabsLabel"),
          items: TABS.map((x) => ({ id: x, label: t(`tabs.${x}`) })),
          value: "versions",
          onChange: () => {},
        }}
        loading={{ content: [{ kind: "key-value", rows: 6, keyWidth: "8ch" }, { kind: "list" }] }}
      />
    );
  }
  const c = list.data.components.find((x) => x.id === id);
  if (c === undefined) return <NotFound />;
  return <AdminTheme c={c} orgId={orgId} />;
}

function AdminTheme({ c, orgId }: { c: PlatformComponent; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("adminComponents.detail");
  const [tab, setTab] = useState<Tab>("versions");
  const vq = componentVersionsQuery("theme", c.id);
  const versions = useQuery({ ...vq, retryOnMount: retryOnMountOf(vq.queryKey) }).data?.versions;
  const locale = useLocale();
  const name = componentName(c, locale);
  const description = componentDescription(c, locale);
  const isDefault = usePlatformDefaultTheme() === c.id;
  // the dialogs and toasts name the theme as the page does
  const { actions, dialog } = useComponentActions({ ...c, name }, orgId, {
    platformDefault: isDefault,
  });
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "themes", href: "/admin/themes" }, { label: name }],
          title: name,
          count: versionLabel(c.version),
          status: <StateBadges c={c} platformDefault={isDefault} />,
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
          {description !== null && (
            <Text variant="prose" tone="muted" pre>
              {description}
            </Text>
          )}
          <ComponentNotes c={c} platformDefault={isDefault} />
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
