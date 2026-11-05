"use client";

import {
  Badge,
  Button,
  Card,
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
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
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
import { usePagePath } from "../../../../../components/shell/path";
import { Link, useRouter } from "../../../../../i18n/navigation";
import {
  adminIconUrl,
  agentTemplateNameOf,
  type CatalogItem,
  type CatalogItemDetail,
  type CatalogItemVersion,
  declaredPermissions,
  displayNameOf,
  type PluginManifest,
  removeCatalogItem,
  skillNameOf,
  templateIdOf,
} from "../../../../../lib/catalog";
import {
  catalogItemQuery,
  catalogItemsQuery,
  marketplacesQuery,
} from "../../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../../lib/query/client";
import { keys } from "../../../../../lib/query/keys";
import { useAppMutation } from "../../../../../lib/query/mutation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

/**
 * What a change to a catalog item changes besides the item: the catalog list (its row), and the
 * current org's view of the catalog (the only org cached).
 */
const itemChangeKeys = (orgId: string | null): (readonly unknown[])[] => [
  keys.deployment().catalog(),
  ...(orgId === null ? [] : [keys.org(orgId).catalog(), keys.org(orgId).catalogItemsAll()]),
];

const TABS = ["overview", "versions"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/catalog/[itemId]`: a catalog item, i.e. a plugin (enterprise admins, DetailPage).
 * Overview: the latest version's components (the extension with the permissions its package
 * declares, the skills, the connector templates, the dependencies and whether the catalog has them),
 * the policy switch (allow / needs approval / disabled); a plugin with an extension can install a
 * chosen version's extension on the deployment (then approved and enabled in the extension admin);
 * deleting the item (confirmed by typing its name); a note when its marketplace now has other content
 * at an imported version; a Claude Code plugin's format and translation report, and the root
 * LICENSE text (collapsed). Versions: each version's source, its origin (git host, repo and commit,
 * pinned or following a branch; an archive URL; the npm registry) and import time. Inspector: the
 * icon (shown as `<img>` through the kernel route) and basic facts, with the latest version's origin.
 * From the query cache (the layout prefetched the three reads on a first load): the item (a 404 is
 * the not-found state), the marketplaces and the catalog (sections: while they load or when they
 * failed, the source labels are left out and the dependencies unchecked). A policy change writes the
 * answer into the cached item.
 */
export default function DirectoryItemViewGate({ itemId }: { itemId: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <DirectoryItemRead itemId={itemId} orgId={gate.me.currentOrgId} />;
}

function DirectoryItemRead({ itemId, orgId }: { itemId: string; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin");
  const read = usePageQuery(catalogItemQuery(itemId));
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "catalog", href: "/admin/catalog" }, { label: itemId }],
          title: "",
        }}
        tabs={{
          label: t("detail.tabsLabel"),
          items: TABS.map((x) => ({ id: x, label: t(`detail.tabs.${x}`) })),
          value: "overview",
          onChange: () => {},
        }}
        // The overview: the five component sections (extension, skills, connector templates,
        // agent templates, dependencies), the policy card (its hint and the three policies) and
        // the delete button; the inspector's facts (package, publisher, latest, source,
        // installs, updated). The deploy card (an extension's) and the license come with the data.
        loading={{
          inspector: { rows: 6, keyWidth: "10ch" },
          content: [
            { kind: "list" },
            { kind: "list" },
            { kind: "list" },
            { kind: "list" },
            { kind: "list" },
            {
              kind: "card",
              card: { lines: 1, lineSize: "small", field: { control: "radios", options: 3 } },
            },
            { kind: "buttons" },
          ],
        }}
      />
    );
  }
  return <DirectoryItemView detail={read.data} orgId={orgId} />;
}

function DirectoryItemView({ detail, orgId }: { detail: CatalogItemDetail; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const origin = useOrigin();
  // Sections: no data while they load or when they failed (not read again on mount).
  const mq = marketplacesQuery();
  const marketplaces = useQuery({ ...mq, retryOnMount: retryOnMountOf(mq.queryKey) }).data?.items;
  const cq = catalogItemsQuery();
  const catalog =
    useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) }).data?.items ?? null;
  const sourceLabel = useSourceLabel(marketplaces ?? []);
  const [tab, setTab] = useState<Tab>("overview");
  const item = detail.item;
  const hasIcon = detail.hasIcon === true;
  const latestDetail = detail.versions.find((v) => v.version === item.latestVersion)?.sourceDetail;

  return (
    <DetailPage
      header={{
        path: [
          ...scope,
          { label: "catalog", href: "/admin/catalog" },
          { label: displayNameOf(item, locale) },
        ],
        title: displayNameOf(item, locale),
        count: versionLabel(item.latestVersion),
        status: <ScopeBadge item={item} />,
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: TABS.map((x) => ({ id: x, label: t(`detail.tabs.${x}`) })),
        value: tab,
        onChange: (x) => setTab(x as Tab),
      }}
      inspectorTitle={item.name}
      inspector={
        <Stack gap={12}>
          {hasIcon && <CatalogIcon src={adminIconUrl(item.id)} name={item.name} />}
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("detail.fields.package"), v: item.packageName ?? "—" },
              { k: t("detail.fields.publisher"), v: item.publisher || "—" },
              { k: t("detail.fields.latest"), v: versionLabel(item.latestVersion) },
              { k: t("detail.fields.source"), v: sourceLabel(item) },
              ...(latestDetail ? [{ k: t("detail.fields.origin"), v: origin(latestDetail) }] : []),
              { k: t("detail.fields.installs"), v: String(item.installs) },
              { k: t("detail.fields.updated"), v: <DateTime value={item.updatedAt} /> },
            ]}
          />
        </Stack>
      }
    >
      {tab === "overview" ? (
        <Overview detail={detail} catalog={catalog} orgId={orgId} />
      ) : (
        <Versions versions={detail.versions} />
      )}
      {item.description && tab === "overview" && (
        <Text variant="prose" tone="muted">
          {item.description}
        </Text>
      )}
      {item.deletedAt !== null && <Text tone="warn">{td("admin.detail.deleted")}</Text>}
    </DetailPage>
  );
}

function Overview({
  detail,
  catalog,
  orgId,
}: {
  detail: CatalogItemDetail;
  catalog: CatalogItem[] | null;
  orgId: string | null;
}) {
  const t = useTranslations("catalog.admin.detail");
  const tt = useTranslations("catalog.admin.review.translation");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const item = detail.item;
  const deleted = item.deletedAt !== null;
  const latest = detail.versions.find((v) => v.version === item.latestVersion);
  const [confirm, setConfirm] = useState(false);
  const remove = useAppMutation({
    fn: () => removeCatalogItem(item.id),
    invalidates: () => [...itemChangeKeys(orgId), catalogItemQuery(item.id).queryKey],
  });

  return (
    <Stack gap={16}>
      {item.contentChanged && <Text tone="warn">{t("contentChanged")}</Text>}
      {latest?.sourceFormat === "claude-code" && (
        <Stack direction="row">
          <Badge>{tt("formatClaude")}</Badge>
        </Stack>
      )}
      {latest !== undefined && <Components manifest={latest.manifest} catalog={catalog} />}
      {latest?.translation != null && <TranslationReportView report={latest.translation} />}
      {latest !== undefined && (
        <LicenseView text={latest.licenseText} truncated={latest.licenseTruncated} />
      )}
      {!deleted && (
        <Stack direction="row">
          <Button variant="danger" onClick={() => setConfirm(true)}>
            {t("delete")}
          </Button>
        </Stack>
      )}
      <DangerConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={t("deleteConfirm.title", { name: item.name })}
        description={t("deleteConfirm.hint")}
        confirmName={item.name}
        confirmLabel={t("deleteConfirm.confirm")}
        onConfirm={async () => {
          await remove.mutateAsync(undefined).catch((e: unknown) => {
            throw new Error(errorMessage(e));
          });
          toast.success(t("deletedToast", { name: item.name }));
          router.push("/admin/catalog");
        }}
      />
    </Stack>
  );
}

/**
 * The components of a version (from its normalized plugin.json): the extension and the permissions
 * its package declares, the skills, the connector templates, and each dependency with the catalog
 * versions of an item of that name (organizations installing the plugin need one satisfying the
 * range; the kernel resolves it at install).
 */
function Components({
  manifest,
  catalog,
}: {
  manifest: PluginManifest;
  /** The deployment catalog; `null` when it could not be read (dependencies are then unchecked). */
  catalog: CatalogItem[] | null;
}) {
  const t = useTranslations("catalog.components");
  const tp = useTranslations("extensions");
  const ext = manifest.extension?.manifest;
  const skills = manifest.skills ?? [];
  const templates = manifest.connectorTemplates ?? [];
  const agentTemplates = manifest.agents ?? [];
  const deps = manifest.dependencies ?? [];
  const label = (category: string) =>
    tp.has(`category.${category}`) ? tp(`category.${category}`) : category;
  return (
    <Stack gap={16}>
      <ComponentSection title={t("extension")} count={ext ? 1 : 0} empty={t("extensionNone")}>
        {ext && (
          <Card
            title={t("extensionVersion", { name: ext.name, version: versionLabel(ext.version) })}
          >
            <Stack gap={8}>
              <Text variant="small" tone="muted">
                {t("declaredHint")}
              </Text>
              <KeyValue
                keyWidth="16ch"
                rows={declaredPermissions(ext).map((g) => ({
                  k: label(g.category),
                  v: g.items.join(", "),
                }))}
              />
            </Stack>
          </Card>
        )}
      </ComponentSection>
      <ComponentSection title={t("skills")} count={skills.length} empty={t("skillsNone")}>
        {skills.map((s) => (
          <Text key={s.path}>{`· ${skillNameOf(s.path)}`}</Text>
        ))}
      </ComponentSection>
      <ComponentSection title={t("templates")} count={templates.length} empty={t("templatesNone")}>
        {templates.map((c) => (
          <Text key={c.path}>{`· ${templateIdOf(c.path)}`}</Text>
        ))}
      </ComponentSection>
      <ComponentSection
        title={t("agentTemplates")}
        count={agentTemplates.length}
        empty={t("agentTemplatesNone")}
      >
        {agentTemplates.map((a) => (
          <Text key={a.path}>{`· ${agentTemplateNameOf(a.path)}`}</Text>
        ))}
      </ComponentSection>
      <ComponentSection title={t("dependencies")} count={deps.length} empty={t("dependenciesNone")}>
        <Text variant="small" tone="muted">
          {t("dependenciesHint")}
        </Text>
        {deps.map((d) => {
          const found = catalog?.find((i) => i.name === d.name);
          return found ? (
            <Text key={d.name}>
              <Link href={`/admin/catalog/${found.id}`}>
                {t("dependencyInCatalog", {
                  name: d.name,
                  range: d.version,
                  versions: found.versions.join(", "),
                })}
              </Link>
            </Text>
          ) : catalog !== null ? (
            <Text key={d.name} tone="warn">
              {t("dependencyNotInCatalog", { name: d.name, range: d.version })}
            </Text>
          ) : (
            // The catalog could not be read: only the name and range
            <Text key={d.name} tone="muted">{`· ${d.name} ${d.version}`}</Text>
          );
        })}
      </ComponentSection>
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
