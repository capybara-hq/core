"use client";

import {
  Badge,
  type Column,
  DangerConfirm,
  DataTable,
  DateTime,
  DetailPage,
  formatBytes,
  KeyValue,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useComponentScopeText } from "../../../../../components/AdminComponents";
import {
  CatalogIcon,
  ComponentSection,
  LicenseView,
  ScopeBadge,
  TranslationReportView,
  useOrigin,
  useSourceLabel,
} from "../../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { PlatformUpdateDialog } from "../../../../../components/PlatformUpdateDialog";
import {
  PluginDisableDialog,
  PluginScopeDialog,
} from "../../../../../components/PluginScopeDialog";
import { useScopeLabel } from "../../../../../components/PluginsHead";
import { usePagePath } from "../../../../../components/shell/path";
import { Link, useRouter } from "../../../../../i18n/navigation";
import {
  adminIconUrl,
  agentTemplateNameOf,
  type CatalogItem,
  type CatalogItemDetail,
  type CatalogItemVersion,
  compareSemver,
  declaredPermissions,
  descriptionOf,
  displayNameOf,
  importMarketplaceEntry,
  importPageHref,
  ownerOrgOf,
  type PluginManifest,
  removeCatalogItem,
  setDisabled,
  shareGated,
  skillNameOf,
  templateIdOf,
} from "../../../../../lib/catalog";
import {
  COMPONENT_ROUTES,
  type PlatformComponent,
  type PlatformComponentKind,
} from "../../../../../lib/components";
import { lockWhileRunning } from "../../../../../lib/header-actions";
import {
  adminOrgsQuery,
  catalogItemQuery,
  catalogItemsQuery,
  marketplacesQuery,
  stagedImportQuery,
} from "../../../../../lib/query/admin";
import { pluginScopeChangeKeys } from "../../../../../lib/query/catalog";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { adminComponentsQuery } from "../../../../../lib/query/components";
import { useAppMutation } from "../../../../../lib/query/mutation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

const TABS = ["components", "orgs", "versions"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/plugins/[itemId]`: one plugin (super admins, DetailPage; spec §9). Head: the name, the
 * platform's version, the 内置 / Claude Code chips and the scope; actions 设置范围 (the scope dialog with
 * its impact preview), 停用 (with the same preview) or 启用, and 更新到 <version> when the catalog has a
 * newer version than the platform's (the platform update preview, spec §7.1), else 导入 <version>
 * when its marketplace has a newer compatible version (stages it and opens the import review). A
 * built-in plugin has neither 设置范围 nor 停用. An org's upload (phase 3) names its owner org, takes no
 * 更新到 / 导入 (its org uploads its versions), only narrows when its org does not share it, and takes
 * no scope change while its first version waits. Tabs: 组件 (the platform version's extension,
 * skills, connector templates and agent templates with kind, version and scope (跟随插件 or the
 * component's own, linking to the component); its dependencies; the translation report), 组织
 * (the scope and the orgs it names, or how many turned it on), 版本 (each version's source, origin and import time). One centred column (no inspector): the full
 * description first, the notes, the icon and the facts (package, source, publisher, owner, scope,
 * orgs using it, the permissions with their state, updated) as a KeyValue, the tab, then the
 * license folded at the end; 删除 is the head's ⋯ menu item. From the query cache (the layout
 * prefetched the reads on a first load): the item (a 404 is the not-found state); the marketplaces,
 * the catalog and the orgs are sections.
 */
export default function PluginDetailGate({ itemId }: { itemId: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <PluginDetailRead itemId={itemId} orgId={gate.me.currentOrgId} />;
}

function PluginDetailRead({ itemId, orgId }: { itemId: string; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin.detail");
  const read = usePageQuery(catalogItemQuery(itemId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "plugins", href: "/admin/plugins" }, { label: itemId }],
          title: "",
        }}
        tabs={{
          label: t("tabsLabel"),
          items: TABS.map((x) => ({ id: x, label: t(`tabs.${x}`) })),
          value: "components",
          onChange: () => {},
        }}
        // The components table and the dependencies; the inspector's six facts.
        // One column: the facts (a KeyValue of nine), the components table and the dependencies
        loading={{
          content: [
            { kind: "key-value", rows: 9, keyWidth: "10ch" },
            { kind: "list" },
            { kind: "list" },
          ],
        }}
      />
    );
  }
  return <PluginDetail detail={read.data} orgId={orgId} />;
}

function PluginDetail({ detail, orgId }: { detail: CatalogItemDetail; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const origin = useOrigin();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const scopeLabel = useScopeLabel();
  const tc = useTranslations("adminComponents");
  const tcm = useTranslations("common");
  // Sections: no data while they load or when they failed (not read again on mount).
  const mq = marketplacesQuery();
  const marketplaces = useQuery({ ...mq, retryOnMount: retryOnMountOf(mq.queryKey) }).data?.items;
  const cq = catalogItemsQuery();
  const catalog =
    useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data?.items ?? null;
  const sourceLabel = useSourceLabel(marketplaces ?? []);
  const [tab, setTab] = useState<Tab>("components");
  const [dialog, setDialog] = useState<"scope" | "disable" | "update" | null>(null);
  const item = detail.item;
  const platformVersion = item.platformVersion ?? item.latestVersion;
  // The highest imported version newer than the platform's: the platform update (a version that
  // does not compare as semver is never offered)
  const updateTo =
    item.versions
      .filter((v) => (compareSemver(v, platformVersion) ?? 0) > 0)
      .sort((a, b) => compareSemver(b, a) ?? 0)[0] ?? null;
  const name = displayNameOf(item, locale);
  const latest = detail.versions.find((v) => v.version === item.latestVersion);
  const ext = latest?.manifest.extension?.manifest;
  const permissionCount =
    ext === undefined ? 0 : declaredPermissions(ext).reduce((n, g) => n + g.items.length, 0);
  const claudeCode = latest?.sourceFormat === "claude-code";
  const deleted = item.deletedAt !== null;
  const fetchable =
    updateTo === null &&
    item.newerInMarketplace &&
    item.marketplaceId !== null &&
    item.latestMarketplaceVersion !== null
      ? { sourceId: item.marketplaceId, version: item.latestMarketplaceVersion }
      : null;

  const enable = useAppMutation({
    fn: () => setDisabled(item.id, { disabled: false }),
    invalidates: () => pluginScopeChangeKeys(orgId),
  });
  const [confirm, setConfirm] = useState(false);
  const remove = useAppMutation({
    fn: () => removeCatalogItem(item.id),
    invalidates: () => pluginScopeChangeKeys(orgId),
    forgetsOnLeave: () => [catalogItemQuery(item.id).queryKey],
  });
  // The release the platform runs (its license is the page's last section)
  const platformRelease =
    detail.versions.find((v) => v.version === platformVersion) ??
    detail.versions.find((v) => v.version === item.latestVersion);
  // Stages the newer marketplace version: the answer is the staged import the review page reads
  const stage = useAppMutation({
    fn: (v: { sourceId: string; version: string }) =>
      importMarketplaceEntry({ sourceId: v.sourceId, name: item.name }, v.version),
    invalidates: () => [],
    onSuccess: (p) => qc.setQueryData(stagedImportQuery(p.stagingId).queryKey, p),
  });
  const run = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const owner = ownerOrgOf(item);
  // An org's upload: its org uploads its versions (ruling P3-12); a first version waiting for the
  // confirmation takes no scope change or disable (409 catalog.item_pending, ruling P3-9)
  const awaiting = item.awaitingConfirmation === true;
  const actions = [
    ...(item.builtin || deleted || awaiting
      ? []
      : [
          {
            label: t("detail.actions.scope"),
            variant: "default" as const,
            onSelect: () => setDialog("scope"),
          },
          item.disabled
            ? {
                label: t("detail.actions.enable"),
                variant: "default" as const,
                loading: enable.isPending,
                onSelect: () =>
                  void run(async () => {
                    await enable.mutateAsync(undefined);
                    toast.success(t("detail.enabledToast", { name }));
                  }),
              }
            : {
                label: t("detail.actions.disable"),
                variant: "default" as const,
                onSelect: () => setDialog("disable"),
              },
        ]),
    ...(updateTo !== null && owner === null && !deleted && !item.disabled
      ? [
          {
            label: t("detail.actions.update", { version: versionLabel(updateTo) }),
            variant: "primary" as const,
            onSelect: () => setDialog("update"),
          },
        ]
      : []),
    ...(fetchable !== null && owner === null && !deleted
      ? [
          {
            label: t("detail.actions.import", { version: versionLabel(fetchable.version) }),
            variant: "primary" as const,
            loading: stage.isPending,
            onSelect: () =>
              void run(async () => {
                const p = await stage.mutateAsync(fetchable);
                router.push(importPageHref(p.stagingId));
              }),
          },
        ]
      : []),
  ];

  // 删除 (a deletable plugin): the head's ⋯ menu, a destructive item (spec §6.7)
  const deletable = !deleted && !item.builtin;
  const headActions = [
    ...actions,
    ...(deletable
      ? [
          {
            label: tcm("moreActions"),
            menu: [{ label: t("detail.delete"), danger: true, onSelect: () => setConfirm(true) }],
          },
        ]
      : []),
  ];
  const description = descriptionOf(item, locale);
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "plugins", href: "/admin/plugins" }, { label: name }],
          title: name,
          count: versionLabel(platformVersion),
          status: (
            <Stack direction="row" gap={8} align="center">
              {item.builtin && <Badge>{t("chips.builtin")}</Badge>}
              {owner !== null && <Badge>{t("chips.owner", { org: owner.name })}</Badge>}
              {claudeCode && <Badge>{t("chips.claudeCode")}</Badge>}
              <ScopeBadge item={item} />
            </Stack>
          ),
          actions: lockWhileRunning(headActions),
        }}
        tabs={{
          label: t("detail.tabsLabel"),
          items: TABS.map((x) => ({
            id: x,
            label: t(`detail.tabs.${x}`),
            ...(x === "components" && latest !== undefined
              ? { count: componentsOf(latest.manifest).length }
              : {}),
          })),
          value: tab,
          onChange: (x) => setTab(x as Tab),
        }}
      >
        <Stack gap={16}>
          {/* The full description, first in the column (the head's line would cut it) */}
          {description !== "" && (
            <Text variant="prose" tone="muted" pre>
              {description}
            </Text>
          )}
          {owner !== null && (
            <Text variant="prose" tone="muted">
              {t("detail.ownerNote", { org: owner.name })}
            </Text>
          )}
          {shareGated(item) && <Text tone="warn">{t("detail.notShareableNote")}</Text>}
          {awaiting ? (
            <Text tone="warn">{t("detail.awaitingNote")}</Text>
          ) : (
            item.pendingVersion !== null &&
            item.pendingVersion !== undefined && (
              <Text tone="warn">
                {t("detail.pendingVersionNote", { version: versionLabel(item.pendingVersion) })}
              </Text>
            )
          )}
          {item.disabled && <Text tone="warn">{t("detail.disabledNote")}</Text>}
          {item.contentChanged && <Text tone="warn">{t("detail.contentChanged")}</Text>}
          {deleted && <Text tone="warn">{td("admin.detail.deleted")}</Text>}
          {/* The facts, in the single column (no right inspector) */}
          {detail.hasIcon && <CatalogIcon src={adminIconUrl(item.id)} name={item.name} />}
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.fields.package"), v: item.packageName ?? "—" },
              { k: t("detail.fields.source"), v: sourceLabel(item) },
              ...(latest?.sourceDetail
                ? [{ k: t("detail.fields.origin"), v: origin(latest.sourceDetail) }]
                : []),
              { k: t("detail.fields.publisher"), v: item.publisher || "—" },
              {
                k: t("detail.fields.owner"),
                v: owner === null ? tc("owner.platform") : owner.name,
              },
              { k: t("detail.fields.scope"), v: scopeLabel(item) },
              { k: t("detail.fields.orgs"), v: String(item.enabledOrgs) },
              {
                k: t("detail.fields.permissions"),
                v:
                  ext === undefined
                    ? t("detail.permissions.none")
                    : item.pending
                      ? t("detail.permissions.pending", { n: permissionCount })
                      : t("detail.permissions.confirmed", { n: permissionCount }),
              },
              { k: t("detail.fields.updated"), v: <DateTime value={item.updatedAt} /> },
            ]}
          />
          {tab === "components" ? (
            <ComponentsTab detail={detail} catalog={catalog} />
          ) : tab === "orgs" ? (
            <OrgsTab item={item} />
          ) : (
            <Versions versions={detail.versions} />
          )}
          {/* 许可证全文: folded, at the end of the page */}
          {platformRelease !== undefined && (
            <LicenseView
              text={platformRelease.licenseText}
              truncated={platformRelease.licenseTruncated}
            />
          )}
        </Stack>
      </DetailPage>
      {dialog === "scope" && (
        <PluginScopeDialog item={item} orgId={orgId} onClose={() => setDialog(null)} />
      )}
      {dialog === "disable" && (
        <PluginDisableDialog item={item} orgId={orgId} onClose={() => setDialog(null)} />
      )}
      {dialog === "update" && updateTo !== null && (
        <PlatformUpdateDialog
          item={item}
          version={updateTo}
          orgId={orgId}
          onClose={() => setDialog(null)}
        />
      )}
      <DangerConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={t("detail.deleteConfirm.title", { name: item.name })}
        description={t("detail.deleteConfirm.hint")}
        confirmName={item.name}
        confirmLabel={t("detail.deleteConfirm.confirm")}
        onConfirm={async () => {
          await remove.mutateAsync(undefined).catch((e: unknown) => {
            throw new Error(errorMessage(e));
          });
          toast.success(t("detail.deletedToast", { name: item.name }));
          router.push("/admin/plugins");
        }}
      />
    </>
  );
}

type ComponentRow = {
  key: string;
  name: string;
  kind: "extension" | "skill" | "connectorTemplate" | "agentTemplate";
  version: string;
};

/** The platform component kind of a manifest row (an extension has none). */
const PLATFORM_KIND: Record<ComponentRow["kind"], PlatformComponentKind | null> = {
  extension: null,
  skill: "skill",
  connectorTemplate: "connector_template",
  agentTemplate: "agent_template",
};

/** The plugin's platform components of each kind (sections: empty while they load or failed). */
function usePluginComponents(itemId: string): (row: ComponentRow) => PlatformComponent | undefined {
  const sq = adminComponentsQuery("skill");
  const cq = adminComponentsQuery("connector_template");
  const aq = adminComponentsQuery("agent_template");
  const skills = useQuery({ ...sq, retryOnMount: retryOnMountOf(sq.queryKey) }).data;
  const connectors = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data;
  const agents = useQuery({ ...aq, retryOnMount: retryOnMountOf(aq.queryKey) }).data;
  const byKind: Record<PlatformComponentKind, PlatformComponent[]> = {
    skill: skills?.components ?? [],
    connector_template: connectors?.components ?? [],
    agent_template: agents?.components ?? [],
  };
  return (row) => {
    const kind = PLATFORM_KIND[row.kind];
    return kind === null
      ? undefined
      : byKind[kind].find((c) => c.itemId === itemId && c.name === row.name);
  };
}

/** The components of a version (its plugin.json): the extension, skills, templates. */
function componentsOf(m: PluginManifest): ComponentRow[] {
  const ext = m.extension?.manifest;
  return [
    ...(ext
      ? [{ key: `e:${ext.name}`, name: ext.name, kind: "extension" as const, version: ext.version }]
      : []),
    ...(m.skills ?? []).map((s) => ({
      key: `s:${s.path}`,
      name: skillNameOf(s.path),
      kind: "skill" as const,
      version: m.version,
    })),
    ...(m.connectorTemplates ?? []).map((c) => ({
      key: `c:${c.path}`,
      name: templateIdOf(c.path),
      kind: "connectorTemplate" as const,
      version: m.version,
    })),
    ...(m.agents ?? []).map((a) => ({
      key: `a:${a.path}`,
      name: agentTemplateNameOf(a.path),
      kind: "agentTemplate" as const,
      version: m.version,
    })),
  ];
}

function ComponentsTab({
  detail,
  catalog,
}: {
  detail: CatalogItemDetail;
  /** The deployment catalog; `null` when it could not be read (dependencies are then unchecked). */
  catalog: CatalogItem[] | null;
}) {
  const t = useTranslations("catalog.admin.detail");
  const tc = useTranslations("catalog.components");
  const item = detail.item;
  const latest =
    detail.versions.find((v) => v.version === (item.platformVersion ?? item.latestVersion)) ??
    detail.versions.find((v) => v.version === item.latestVersion);
  const tcs = useTranslations("adminComponents");
  const componentOf = usePluginComponents(item.id);
  const scopeText = useComponentScopeText();
  const rows = latest === undefined ? [] : componentsOf(latest.manifest);
  const deps = latest?.manifest.dependencies ?? [];
  const columns: Column<ComponentRow>[] = [
    {
      key: "name",
      header: t("componentColumns.name"),
      cell: (row) => {
        const c = componentOf(row);
        return c === undefined ? (
          row.name
        ) : (
          <Link href={`${COMPONENT_ROUTES[c.kind]}/${encodeURIComponent(c.id)}`}>{row.name}</Link>
        );
      },
    },
    { key: "kind", header: t("componentColumns.kind"), cell: (c) => t(`kind.${c.kind}`) },
    {
      key: "version",
      header: t("componentColumns.version"),
      tone: "muted",
      cell: (c) => versionLabel(c.version),
    },
    {
      key: "scope",
      header: t("componentColumns.scope"),
      tone: "muted",
      // The extension and a component following the plugin: 跟随插件; else its own scope
      cell: (row) => {
        const c = componentOf(row);
        return c === undefined || c.scopeMode === "follow" ? tcs("follow") : scopeText(c);
      },
    },
  ];
  return (
    <Stack gap={16}>
      <DataTable
        label={t("tabs.components")}
        columns={columns}
        rows={rows}
        rowKey={(c) => c.key}
        state="ready"
        empty={{ title: t("componentsEmpty") }}
      />
      {deps.length > 0 && (
        <ComponentSection title={tc("dependencies")} count={deps.length} empty="">
          <Text variant="small" tone="muted">
            {tc("dependenciesHint")}
          </Text>
          {deps.map((d) => {
            const found = catalog?.find((i) => i.name === d.name);
            return found ? (
              <Text key={d.name}>
                <Link href={`/admin/plugins/${found.id}`}>
                  {tc("dependencyInCatalog", {
                    name: d.name,
                    range: d.version,
                    versions: found.versions.join(", "),
                  })}
                </Link>
              </Text>
            ) : catalog !== null ? (
              <Text key={d.name} tone="warn">
                {tc("dependencyNotInCatalog", { name: d.name, range: d.version })}
              </Text>
            ) : (
              // The catalog could not be read: only the name and range
              <Text key={d.name} tone="muted">{`${d.name} ${d.version}`}</Text>
            );
          })}
        </ComponentSection>
      )}
      {latest?.translation != null && <TranslationReportView report={latest.translation} />}
    </Stack>
  );
}

/** 组织: who the scope gives the plugin to; the named orgs (or every org for 全部组织启用). */
function OrgsTab({ item }: { item: CatalogItem }) {
  const t = useTranslations("catalog.admin.detail");
  const oq = adminOrgsQuery();
  const orgs = useQuery({ ...oq, retryOnMount: retryOnMountOf(oq.queryKey) });
  const all = orgs.data?.orgs ?? [];
  const rows =
    item.scope === "all"
      ? all
      : item.scope === "named"
        ? item.scopeOrgs.map(
            (id) =>
              all.find((o) => o.id === id) ?? {
                id,
                slug: "—",
                name: id,
                createdAt: "",
                memberCount: 0,
              },
          )
        : [];
  return (
    <Stack gap={12}>
      <Text variant="prose" tone="muted">
        {t(`orgsHint.${item.scope}`, { n: item.enabledOrgs })}
      </Text>
      {item.scope !== "optional" && (
        <DataTable
          label={t("tabs.orgs")}
          columns={[
            { key: "name", header: t("orgColumns.name"), cell: (o) => o.name },
            { key: "slug", header: t("orgColumns.slug"), tone: "muted", cell: (o) => o.slug },
          ]}
          rows={rows}
          rowKey={(o) => o.id}
          state={orgs.data === undefined && orgs.isPending ? "loading" : "ready"}
          empty={{ title: t("orgsEmpty") }}
        />
      )}
    </Stack>
  );
}

function Versions({ versions }: { versions: CatalogItemVersion[] }) {
  const t = useTranslations("catalog.admin.detail.versionColumns");
  const tv = useTranslations("catalog.versionSource");
  const tf = useTranslations("catalog.admin.detail.format");
  const origin = useOrigin();
  const columns: Column<CatalogItemVersion>[] = [
    { key: "version", header: t("version"), cell: (v) => versionLabel(v.version) },
    { key: "source", header: t("source"), cell: (v) => tv(v.source) },
    {
      key: "format",
      header: t("format"),
      cell: (v) => (v.sourceFormat === "claude-code" ? tf("claudeCode") : tf("capybara")),
    },
    { key: "ref", header: t("ref"), tone: "muted", cell: (v) => v.sourceRef },
    {
      key: "origin",
      header: t("origin"),
      tone: "muted",
      cell: (v) => (v.sourceDetail === null ? "—" : origin(v.sourceDetail)),
    },
    { key: "size", header: t("size"), tone: "muted", cell: (v) => formatBytes(v.size) },
    {
      key: "imported",
      header: t("imported"),
      tone: "muted",
      cell: (v) => <DateTime value={v.importedAt} />,
    },
  ];
  return (
    <DataTable
      label={t("version")}
      columns={columns}
      rows={versions}
      rowKey={(v) => v.version}
      state="ready"
      empty={{ title: "—" }}
    />
  );
}
