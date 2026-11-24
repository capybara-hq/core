"use client";

import {
  Badge,
  Callout,
  type Column,
  DangerConfirm,
  DataTable,
  DateTime,
  DetailPage,
  formatBytes,
  KeyValue,
  ObjectMark,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useComponentScopeText } from "../../../../../components/AdminComponents";
import { useApplyAppearance } from "../../../../../components/ApplyAppearance";
import { ScopeBadge, useOrigin, useSourceLabel } from "../../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../components/NoAccess";
import { PlatformUpdateDialog } from "../../../../../components/PlatformUpdateDialog";
import {
  PluginDisableDialog,
  PluginScopeDialog,
} from "../../../../../components/PluginScopeDialog";
import { useScopeLabel } from "../../../../../components/PluginsHead";
import {
  fromManifest,
  licenseOf,
  manifestCount,
  platformVersionOf,
} from "../../../../../components/plugin-contents/from-manifest";
import {
  LicenseFact,
  PluginContents,
} from "../../../../../components/plugin-contents/PluginContents";
import { usePagePath } from "../../../../../components/shell/path";
import { Link, useRouter } from "../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../lib/api";
import {
  adminIconUrl,
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
  removeCatalogItem,
  setDisabled,
  shareGated,
} from "../../../../../lib/catalog";
import { COMPONENT_ROUTES, type PlatformComponent } from "../../../../../lib/components";
import { extensionLabel, labelLocale } from "../../../../../lib/extension-label";
import { lockWhileRunning } from "../../../../../lib/header-actions";
import {
  adminExtensionQuery,
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

/** An org's upload whose first version waits for the super admin (no platform action yet). */
const awaitingOf = (item: CatalogItem): boolean => item.awaitingConfirmation === true;

/**
 * `/admin/plugins/[itemId]`: one plugin (super admins, DetailPage; spec §9). Head: the name, the
 * platform's version, the 内置 / Claude Code chips and the scope; actions 设置范围 (the scope dialog with
 * its impact preview), 停用 (with the same preview) or 启用, and one 更新到 <version> (maintainer
 * decision 2026-11-13): to the newest version its marketplace has when that is newer than every
 * imported one (stages it and opens the one wizard at `/admin/plugins/import?staging=<id>`: the
 * import review, then the update preview, confirmed together), else to the newest imported
 * version newer than the platform's (the platform update preview dialog, spec §7.1). The 版本 tab's
 * row menu moves the platform to any other imported version (更新到 / 回退到, the same dialog). A
 * built-in plugin has neither 设置范围 nor 停用. An org's upload (phase 3) names its owner org, takes no
 * 更新到 or version moves (its org uploads its versions), only narrows when its org does not share
 * it, and takes no scope change while its first version waits. Tabs: 组件 (the platform version's extension,
 * skills, connector templates and agent templates with kind, version and scope (跟随插件 or the
 * component's own, linking to the component); its dependencies; the translation report), 组织
 * (the scope and the orgs it names, or how many turned it on), 版本 (each version's source, origin and import time). One centred column (no inspector): the full
 * description first, the notes and the facts (the icon is the head's 40 px mark) (package, source, publisher, owner, scope,
 * orgs using it, the permissions with their state, updated) as a KeyValue, the tab, then the
 * license as a fact (its full text opens a Dialog); Delete is the head's ⋯ menu item. Apply this plugin's appearance (a plugin with a
 * suggested appearance, client extensions spec §6.5) previews the platform changes in a confirm
 * dialog, then applies them. From the query cache (the layout
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
        // The facts (the description over a KeyValue of nine), then the components table and the
        // dependencies
        loading={{
          facts: { rows: 9, keyWidth: "10ch", lead: true },
          content: [{ kind: "list" }, { kind: "list" }],
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
  const [dialog, setDialog] = useState<"scope" | "disable" | null>(null);
  /** The version the platform update dialog moves to (更新到, or a 版本 row's move). */
  const [moveTo, setMoveTo] = useState<string | null>(null);
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
  // The marketplace's newer version, when it is newer than every imported one: 更新到 stages it
  // and opens the one wizard (the import review, then the update preview)
  const fetchable =
    item.newerInMarketplace &&
    item.marketplaceId !== null &&
    item.latestMarketplaceVersion !== null &&
    (updateTo === null || (compareSemver(item.latestMarketplaceVersion, updateTo) ?? 0) > 0)
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
  // The plugin's extension on the deployment: while it is enabled the delete is refused (409
  // catalog.extension_enabled), so the confirm says so up front. Not installed: a 404, no data.
  const extName = ext?.name ?? null;
  const eq = adminExtensionQuery(extName ?? item.name);
  const deployed = useQuery({
    ...eq,
    enabled: extName !== null && !deleted,
    retry: false,
    retryOnMount: retryOnMountOf(eq.queryKey),
  }).data;
  const enabledExtension =
    deployed !== undefined && deployed.desired?.state === "enabled" ? deployed : null;
  const lang = labelLocale(locale);
  /** The delete's error: an enabled extension named, anything else by its code. */
  const deleteError = (e: unknown): string => {
    if (e instanceof ApiClientError && e.code === "catalog.extension_enabled") {
      const d = e.rawDetails[0] as
        | { extension?: string; displayName?: { zh: string; en: string } | null }
        | undefined;
      const label =
        enabledExtension !== null
          ? extensionLabel(enabledExtension, lang)
          : extensionLabel(
              { name: d?.extension ?? item.name, displayName: d?.displayName ?? null },
              lang,
            );
      return t("detail.deleteExtensionEnabled", { name: label });
    }
    return errorMessage(e);
  };
  // The release the platform runs (its license is one of the facts)
  const platformRelease =
    detail.versions.find((v) => v.version === platformVersion) ??
    detail.versions.find((v) => v.version === item.latestVersion);
  const license = licenseOf(platformRelease);
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

  // 应用此插件的外观 (client extensions spec §6.5): only for a plugin that suggests one and is on
  const appearance = useApplyAppearance(
    { kind: "platform", itemId: item.id },
    name,
    platformRelease?.client != null,
  );
  const suggests =
    detail.suggestedAppearance != null && !deleted && !item.disabled && !awaitingOf(item);

  const owner = ownerOrgOf(item);
  // An org's upload: its org uploads its versions (ruling P3-12); a first version waiting for the
  // confirmation takes no scope change or disable (409 catalog.item_pending, ruling P3-9)
  const awaiting = item.awaitingConfirmation === true;
  // The platform moves between versions (更新到, a 版本 row's move): a live, enabled platform plugin
  const movable = owner === null && !deleted && !item.disabled && !awaiting;
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
    ...(suggests
      ? [
          {
            label: t("detail.actions.applyAppearance"),
            variant: "default" as const,
            loading: appearance.previewing,
            onSelect: appearance.preview,
          },
        ]
      : []),
    // One 更新到: the marketplace's newer version through the one wizard, else an imported one
    ...(fetchable !== null && movable
      ? [
          {
            label: t("detail.actions.update", { version: versionLabel(fetchable.version) }),
            variant: "primary" as const,
            loading: stage.isPending,
            onSelect: () =>
              void run(async () => {
                const p = await stage.mutateAsync(fetchable);
                router.push(importPageHref(p.stagingId));
              }),
          },
        ]
      : updateTo !== null && movable
        ? [
            {
              label: t("detail.actions.update", { version: versionLabel(updateTo) }),
              variant: "primary" as const,
              onSelect: () => setMoveTo(updateTo),
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
  // What needs attention, said once above the tabs as one notice (not repeated per tab)
  const notes = [
    ...(shareGated(item) ? [t("detail.notShareableNote")] : []),
    ...(awaiting
      ? [t("detail.awaitingNote")]
      : item.pendingVersion !== null && item.pendingVersion !== undefined
        ? [t("detail.pendingVersionNote", { version: versionLabel(item.pendingVersion) })]
        : []),
    ...(item.disabled ? [t("detail.disabledNote")] : []),
    ...(item.contentChanged ? [t("detail.contentChanged")] : []),
    ...(deleted ? [td("admin.detail.deleted")] : []),
  ];
  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "plugins", href: "/admin/plugins" }, { label: name }],
          avatar: (
            <ObjectMark
              size={40}
              text={name}
              image={detail.hasIcon ? adminIconUrl(item.id) : null}
            />
          ),
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
          ...(notes.length > 0
            ? {
                notice: (
                  <Callout tone="warn">
                    {notes.length === 1 ? (
                      notes[0]
                    ) : (
                      <Stack gap={4}>
                        {notes.map((n) => (
                          <span key={n}>{n}</span>
                        ))}
                      </Stack>
                    )}
                  </Callout>
                ),
              }
            : {}),
        }}
        facts={
          <Stack gap={12}>
            {/* The full description (the head's line would cut it), then the facts */}
            {description !== "" && (
              <Text variant="prose" tone="muted" pre>
                {description}
              </Text>
            )}
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
                  v:
                    owner === null
                      ? tc("owner.platform")
                      : t("detail.ownerValue", { org: owner.name }),
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
                ...(license !== undefined
                  ? [{ k: td("admin.review.facts.license"), v: <LicenseFact license={license} /> }]
                  : []),
              ]}
            />
          </Stack>
        }
        tabs={{
          label: t("detail.tabsLabel"),
          items: TABS.map((x) => ({
            id: x,
            label: t(`detail.tabs.${x}`),
            ...(x === "components" && latest !== undefined
              ? { count: manifestCount(platformVersionOf(detail)?.manifest ?? latest.manifest) }
              : {}),
          })),
          value: tab,
          onChange: (x) => setTab(x as Tab),
        }}
      >
        <Stack gap={16}>
          {tab === "components" ? (
            <ComponentsTab detail={detail} catalog={catalog} />
          ) : tab === "orgs" ? (
            <OrgsTab item={item} />
          ) : (
            <Versions
              versions={detail.versions}
              platformVersion={platformVersion}
              {...(movable ? { onMove: setMoveTo } : {})}
            />
          )}
        </Stack>
      </DetailPage>
      {appearance.dialog}
      {dialog === "scope" && (
        <PluginScopeDialog item={item} orgId={orgId} onClose={() => setDialog(null)} />
      )}
      {dialog === "disable" && (
        <PluginDisableDialog item={item} orgId={orgId} onClose={() => setDialog(null)} />
      )}
      {moveTo !== null && (
        <PlatformUpdateDialog
          item={item}
          version={moveTo}
          orgId={orgId}
          onClose={() => setMoveTo(null)}
        />
      )}
      <DangerConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={t("detail.deleteConfirm.title", { name: item.name })}
        description={
          <Stack gap={8}>
            <Text>{t("detail.deleteConfirm.hint")}</Text>
            {enabledExtension !== null ? (
              <Callout tone="warn">
                <Stack gap={4}>
                  <Text>
                    {t("detail.deleteExtensionEnabled", {
                      name: extensionLabel(enabledExtension, lang),
                    })}
                  </Text>
                  <Text>
                    <Link href={`/admin/extensions/${encodeURIComponent(enabledExtension.name)}`}>
                      {t("detail.deleteConfirm.openExtension")}
                    </Link>
                  </Text>
                </Stack>
              </Callout>
            ) : (
              ext !== undefined && (
                <Text variant="small" tone="muted">
                  {t("detail.deleteConfirm.extensionNote")}
                </Text>
              )
            )}
          </Stack>
        }
        confirmName={item.name}
        confirmLabel={t("detail.deleteConfirm.confirm")}
        confirmDisabled={enabledExtension !== null}
        onConfirm={async () => {
          await remove.mutateAsync(undefined).catch((e: unknown) => {
            throw new Error(deleteError(e));
          });
          toast.success(t("detail.deletedToast", { name: item.name }));
          router.push("/admin/plugins");
        }}
      />
    </>
  );
}

/** The platform's skills, connector templates and agent templates (sections: empty while they load or failed). */
function usePluginComponents(): PlatformComponent[] {
  const sq = adminComponentsQuery("skill");
  const cq = adminComponentsQuery("connector_template");
  const aq = adminComponentsQuery("agent_template");
  const skills = useQuery({ ...sq, retryOnMount: retryOnMountOf(sq.queryKey) }).data;
  const connectors = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data;
  const agents = useQuery({ ...aq, retryOnMount: retryOnMountOf(aq.queryKey) }).data;
  return [
    ...(skills?.components ?? []),
    ...(connectors?.components ?? []),
    ...(agents?.components ?? []),
  ];
}

/**
 * Components: the contents of the version the platform runs (the one plugin contents view): the
 * extension with its client code and client components under it, skills, connector templates,
 * agent templates and themes, each with its scope (follow the plugin, or its own, linking to the component),
 * the dependencies and the translation report. The license is the page's fact.
 */
function ComponentsTab({
  detail,
  catalog,
}: {
  detail: CatalogItemDetail;
  /** The deployment catalog; `null` when it could not be read (dependencies are then unchecked). */
  catalog: CatalogItem[] | null;
}) {
  const t = useTranslations("catalog.admin.detail");
  const tcs = useTranslations("adminComponents");
  const locale = useLocale();
  const components = usePluginComponents();
  const scopeText = useComponentScopeText();
  const model = fromManifest(detail, components, locale, {
    catalog,
    slots: {
      // The extension and a component following the plugin: "follow the plugin"; else its own scope
      scope: (_kind, c) =>
        c === undefined ? (
          <Text variant="small" tone="muted">
            {tcs("follow")}
          </Text>
        ) : (
          <Link href={`${COMPONENT_ROUTES[c.kind]}/${encodeURIComponent(c.id)}`}>
            {c.scopeMode === "follow" ? tcs("follow") : scopeText(c)}
          </Link>
        ),
      extensionLines: (client, ui) => (
        <Stack gap={4}>
          {client !== null && (
            <Text variant="small" tone="muted">
              {t("clientFiles", { files: client.files })}
            </Text>
          )}
          {ui.length > 0 && (
            <Text variant="small" tone="muted">
              {t("uiComponents", { ids: ui.join(", ") })}
            </Text>
          )}
        </Stack>
      ),
      dependency: (found, catalogRead) =>
        found !== undefined ? (
          <Text variant="small" tone="muted">
            {t("dependencyVersions", { versions: found.versions.join(", ") })}
          </Text>
        ) : catalogRead ? (
          <Text variant="small" tone="warn">
            {t("dependencyMissing")}
          </Text>
        ) : null,
    },
  });
  return <PluginContents model={model} audience="platform" stage="detail" />;
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

/**
 * 版本: each imported version. With `onMove` (a platform plugin that can move) a row other than
 * the platform's version has a menu moving the platform to it: 更新到 a newer one, 回退到 an older
 * one (the platform update preview, spec §7.1; rollback stays here, maintainer decision
 * 2026-11-13).
 */
function Versions({
  versions,
  platformVersion,
  onMove,
}: {
  versions: CatalogItemVersion[];
  platformVersion: string;
  onMove?: (version: string) => void;
}) {
  const t = useTranslations("catalog.admin.detail.versionColumns");
  const ta = useTranslations("catalog.admin.detail.actions");
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
      {...(onMove !== undefined
        ? {
            rowMenu: (v: CatalogItemVersion) =>
              v.version === platformVersion
                ? []
                : [
                    {
                      label:
                        (compareSemver(v.version, platformVersion) ?? 0) > 0
                          ? ta("update", { version: versionLabel(v.version) })
                          : ta("rollback", { version: versionLabel(v.version) }),
                      onSelect: () => onMove(v.version),
                    },
                  ],
          }
        : {})}
    />
  );
}
