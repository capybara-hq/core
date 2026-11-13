"use client";

import { ListPage, ObjectRow, Stack, Text, versionLabel } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useCatalogErrorLines, useSourceLabel } from "../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import {
  pluginState,
  useComponentsLabel,
  usePluginsHead,
  useScopeLabel,
} from "../../../../components/PluginsHead";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import { issueLines } from "../../../../lib/api";
import {
  type CatalogItem,
  descriptionOf,
  displayNameOf,
  importMarketplaceEntry,
  importPageHref,
  ownerOrgOf,
  shareGated,
} from "../../../../lib/catalog";
import {
  catalogItemsQuery,
  marketplacesQuery,
  stagedImportQuery,
} from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/admin/plugins`: the deployment's plugins (super admins, ListPage, tab 已安装). A row: the
 * name with the 内置 chip for a built-in plugin, 归属：<org> for an org's upload (and 该组织未开放共享
 * when its org does not share it), the description, a meta line (version, source,
 * scope with the named orgs, how many orgs use it) and the state: 已停用, 权限待确认 (with
 * 确认权限 leading to the 待确认 tab), 可更新 <version> when its marketplace has a newer
 * compatible version, else 运行中. A platform plugin whose marketplace has a newer version has one
 * action, 更新到 <version> (maintainer decision 2026-11-13): it stages that version and opens the
 * one wizard (the import review, then the update preview, confirmed together); a refusal is the
 * list's fail callout. The head (shared by the three tabs) holds 添加市场源 and
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
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [notice, setNotice] = useState<{ message: string; extra: string[] }>();
  const [busy, setBusy] = useState<string>();
  // Stages the marketplace's newer version for the wizard (nothing cached changes until confirmed)
  const stage = useAppMutation({
    fn: (v: { sourceId: string; name: string; version: string }) =>
      importMarketplaceEntry({ sourceId: v.sourceId, name: v.name }, v.version),
    invalidates: () => [],
    onSuccess: (p) => qc.setQueryData(stagedImportQuery(p.stagingId).queryKey, p),
  });
  /** The marketplace's newer version of a platform plugin that can move to it, else null. */
  const updatableTo = (i: CatalogItem) =>
    ownerOrgOf(i) === null &&
    !i.pending &&
    !i.disabled &&
    i.newerInMarketplace &&
    i.marketplaceId !== null &&
    i.latestMarketplaceVersion !== null
      ? { sourceId: i.marketplaceId, version: i.latestMarketplaceVersion }
      : null;
  const update = async (i: CatalogItem, to: { sourceId: string; version: string }) => {
    if (busy !== undefined) return;
    setBusy(i.id);
    setNotice(undefined);
    try {
      const p = await stage.mutateAsync({ ...to, name: i.name });
      router.push(importPageHref(p.stagingId));
    } catch (e) {
      setNotice({ message: errorMessage(e), extra: [...issueLines(e), ...catalogLines(e)] });
    } finally {
      setBusy(undefined);
    }
  };
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
      {...(notice !== undefined
        ? {
            callout: {
              tone: "fail" as const,
              children: (
                <Stack gap={4}>
                  <Text tone="fail">{notice.message}</Text>
                  {notice.extra.map((m) => (
                    <Text key={m} variant="small" tone="fail">
                      {m}
                    </Text>
                  ))}
                </Stack>
              ),
            },
          }
        : {})}
    >
      {rows.map((i) => {
        const name = displayNameOf(i, locale);
        const state = pluginState(i, t);
        const to = updatableTo(i);
        return (
          <ObjectRow
            key={i.id}
            mark={{
              text: name,
              image: i.icon ?? null,
              ...(i.pending ? { tone: "warn" as const } : {}),
            }}
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
              : to !== null
                ? {
                    action: {
                      label: t("detail.actions.update", { version: versionLabel(to.version) }),
                      onSelect: () => void update(i, to),
                    },
                  }
                : {})}
          />
        );
      })}
    </ListPage>
  );
}
