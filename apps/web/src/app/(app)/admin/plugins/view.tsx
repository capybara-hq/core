"use client";

import { ListPage, ObjectRow, versionLabel } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useSourceLabel } from "../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import {
  pluginState,
  useComponentsLabel,
  usePluginsHead,
  useScopeLabel,
} from "../../../../components/PluginsHead";
import { usePagePath } from "../../../../components/shell/path";
import {
  type CatalogItem,
  descriptionOf,
  displayNameOf,
  ownerOrgOf,
  shareGated,
} from "../../../../lib/catalog";
import { catalogItemsQuery, marketplacesQuery } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/admin/plugins`: the deployment's plugins (super admins, ListPage, tab 已安装). A row: the
 * name with the 内置 chip for a built-in plugin, 归属：<org> for an org's upload (and 该组织未开放共享
 * when its org does not share it), the description, a meta line (version, source,
 * scope with the named orgs, how many orgs use it) and the state: 已停用, 权限待确认 (with
 * 确认权限 leading to the 待确认 tab), 可更新 <version> when its marketplace has a newer
 * compatible version, else 运行中. The head (shared by the three tabs) holds 添加市场源 and
 * 上传插件包; the search narrows by name. From the query cache (the layout prefetched the items and
 * the head's counts on a first load); the marketplaces (source labels) and the orgs (named scope)
 * are sections.
 */
export default function AdminPluginsView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminPluginsRead />;
}

function AdminPluginsRead() {
  const scope = usePagePath("admin");
  const head = usePluginsHead("installed");
  const read = usePageQuery(catalogItemsQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <ListPage
        header={{ ...head, path: [...scope, { label: "plugins" }] }}
        variant="objects"
        loading
      />
    );
  }
  return <AdminPlugins all={read.data.items} />;
}

function AdminPlugins({ all }: { all: CatalogItem[] }) {
  const scope = usePagePath("admin");
  const head = usePluginsHead("installed");
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const mq = marketplacesQuery();
  const marketplaces = useQuery({ ...mq, retryOnMount: retryOnMountOf(mq.queryKey) }).data?.items;
  const sourceLabel = useSourceLabel(marketplaces ?? []);
  const scopeLabel = useScopeLabel();
  const componentsLabel = useComponentsLabel();
  const [q, setQ] = useState("");
  // An org's upload: its owner, and whether its org shares it (rulings P3-1, P3-16)
  const ownerChips = (i: CatalogItem) => {
    const owner = ownerOrgOf(i);
    return owner === null
      ? []
      : [
          { label: t("chips.owner", { org: owner.name }) },
          ...(shareGated(i) ? [{ label: t("chips.notShareable") }] : []),
        ];
  };
  const needle = q.trim().toLowerCase();
  const rows = all.filter(
    (i) =>
      needle === "" ||
      i.name.toLowerCase().includes(needle) ||
      displayNameOf(i, locale).toLowerCase().includes(needle),
  );
  const empty =
    all.length === 0
      ? {
          text: t("empty"),
          action: {
            label: t("actions.upload"),
            variant: "primary" as const,
            href: "/admin/plugins/import",
          },
        }
      : rows.length === 0
        ? { text: t("noResults") }
        : undefined;

  return (
    <ListPage
      header={{
        ...head,
        path: [...scope, { label: "plugins" }],
        // An empty list has nothing to search.
        ...(all.length > 0 ? { search: { label: t("search"), value: q, onChange: setQ } } : {}),
      }}
      variant="objects"
      listLabel={t("title")}
      {...(empty ? { empty } : {})}
    >
      {rows.map((i) => {
        const name = displayNameOf(i, locale);
        const state = pluginState(i, t);
        return (
          <ObjectRow
            key={i.id}
            mark={{ text: name, ...(i.pending ? { tone: "warn" as const } : {}) }}
            name={name}
            href={`/admin/plugins/${encodeURIComponent(i.id)}`}
            chips={[
              ...(i.builtin ? [{ label: t("chips.builtin") }] : []),
              ...ownerChips(i),
              ...(i.sourceFormat === "claude-code" ? [{ label: t("chips.claudeCode") }] : []),
              ...(i.contentChanged ? [{ label: td("contentChanged"), tone: "warn" as const }] : []),
            ]}
            description={descriptionOf(i, locale)}
            meta={[
              versionLabel(i.latestVersion),
              sourceLabel(i),
              componentsLabel(i.componentCounts),
              scopeLabel(i),
              t("meta.orgsUsing", { n: i.enabledOrgs }),
            ]}
            state={state}
            {...(i.pending
              ? { action: { label: t("rowConfirm"), href: "/admin/plugins/pending" } }
              : {})}
          />
        );
      })}
    </ListPage>
  );
}
