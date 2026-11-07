"use client";

import { versionLabel } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type PluginTab, pluginTabs } from "../lib/admin-tabs";
import type { CatalogItem, ComponentCounts } from "../lib/catalog";
import {
  adminOrgsQuery,
  catalogItemsQuery,
  deploymentRequestsQuery,
  pendingPluginsQuery,
} from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";

/**
 * How many things wait in the admin 待确认 tab: the plugins whose permissions need confirming
 * plus the pending requests (undefined until both are read, or when `enabled` is false). The
 * sidebar's 插件 item shows the same number (spec §9, Ruling I).
 */
export function usePluginPendingCount(enabled = true): number | undefined {
  const pq = pendingPluginsQuery();
  const rq = deploymentRequestsQuery();
  const pending = useQuery({ ...pq, enabled, retryOnMount: retryOnMountOf(pq.queryKey) }).data;
  const requests = useQuery({ ...rq, enabled, retryOnMount: retryOnMountOf(rq.queryKey) }).data;
  if (pending === undefined || requests === undefined) return undefined;
  return pending.items.length + requests.requests.length;
}

/**
 * The shared head of the admin 插件 pages (all but `path`, which each page writes itself): the
 * title, the description, the actions 添加市场源 and 上传插件包 (primary), and the tabs 已安装 /
 * 市场 / 待确认 with their counts. The counts are sections: while they load or when they failed
 * the tabs carry none.
 */
export function usePluginsHead(active: PluginTab) {
  const t = useTranslations("catalog.admin");
  const cq = catalogItemsQuery();
  const installed = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data?.items
    .length;
  const pending = usePluginPendingCount();
  return {
    title: t("title"),
    description: t("description"),
    actions: [
      {
        label: t("actions.addSource"),
        variant: "default" as const,
        href: "/admin/plugins/sources",
      },
      {
        label: t("actions.upload"),
        icon: "upload" as const,
        variant: "primary" as const,
        href: "/admin/plugins/import",
      },
    ],
    tabs: pluginTabs(t, { installed, pending }),
    activeTab: active,
  };
}

type T = ReturnType<typeof useTranslations<"catalog.admin">>;

/** A plugin's state label: 已停用, 权限待确认, 可更新 <version>, or 运行中. */
export function pluginState(
  i: CatalogItem,
  t: T,
): { label: string; tone: "ok" | "warn" | "muted" } {
  if (i.disabled) return { label: t("state.disabled"), tone: "muted" };
  if (i.pending) return { label: t("state.pending"), tone: "warn" };
  if (i.newerInMarketplace && i.latestMarketplaceVersion !== null) {
    return {
      label: t("state.update", { version: versionLabel(i.latestMarketplaceVersion) }),
      tone: "warn",
    };
  }
  return { label: t("state.running"), tone: "ok" };
}

/**
 * A plugin's scope as text: 全部组织启用, 组织自选, or 指定：<org names> (the ids when the orgs
 * could not be read).
 */
export function useScopeLabel(): (
  i: Pick<CatalogItem, "scope" | "scopeOrgs" | "offCount">,
) => string {
  const t = useTranslations("catalog");
  const locale = useLocale();
  const oq = adminOrgsQuery();
  const orgs = useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) }).data?.orgs;
  return (i) =>
    i.scope === "all" && (i.offCount ?? 0) > 0
      ? t("admin.meta.allOff", { n: i.offCount ?? 0 })
      : i.scope === "named" && i.scopeOrgs.length > 0
        ? t("admin.meta.named", {
            orgs: i.scopeOrgs
              .map((id) => orgs?.find((o) => o.id === id)?.name ?? id)
              .join(locale === "zh" ? "、" : ", "),
          })
        : t(`scope.${i.scope}`);
}

/** A plugin's components as text: 1 个扩展 · 2 个技能 · … (kinds it has none of are left out). */
export function useComponentsLabel(): (c: ComponentCounts) => string {
  const t = useTranslations("catalog.admin.meta.components");
  return (c) => {
    const parts = [
      ...(c.extension > 0 ? [t("extension", { n: c.extension })] : []),
      ...(c.skills > 0 ? [t("skills", { n: c.skills })] : []),
      ...(c.connectorTemplates > 0 ? [t("connectorTemplates", { n: c.connectorTemplates })] : []),
      ...(c.agentTemplates > 0 ? [t("agentTemplates", { n: c.agentTemplates })] : []),
    ];
    return parts.length === 0 ? t("none") : parts.join(" · ");
  };
}
