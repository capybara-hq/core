"use client";

import {
  Badge,
  Button,
  Card,
  type Column,
  DangerConfirm,
  DataTable,
  DetailPage,
  Field,
  formatBytes,
  KeyValue,
  RadioGroup,
  Select,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../../components/AdminGate";
import { formatTime } from "../../../../../../components/ApprovalCard";
import {
  CatalogIcon,
  ComponentSection,
  LicenseView,
  PolicyBadge,
  TranslationReportView,
  useOrigin,
  useSourceLabel,
} from "../../../../../../components/CatalogParts";
import { FormError } from "../../../../../../components/form-error";
import { Link, useRouter } from "../../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../../lib/api";
import {
  adminIconUrl,
  CATALOG_POLICIES,
  type CatalogItem,
  type CatalogItemDetail,
  type CatalogItemVersion,
  type CatalogPolicy,
  declaredPermissions,
  displayNameOf,
  getCatalogItem,
  installItemToDeployment,
  listCatalogItems,
  listMarketplaces,
  type PluginManifest,
  removeCatalogItem,
  setCatalogPolicy,
  skillNameOf,
  templateIdOf,
} from "../../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

const TABS = ["overview", "versions"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/[locale]/admin/catalog/[itemId]`: a catalog item, i.e. a plugin (enterprise admins, DetailPage).
 * Overview: the latest version's components (the extension with the permissions its package
 * declares, the skills, the connector templates, the dependencies and whether the catalog has them),
 * the policy switch (allow / needs approval / disabled); a plugin with an extension can install a
 * chosen version's extension on the deployment (then approved and enabled in the extension admin);
 * deleting the item (confirmed by typing its name); a note when its marketplace now has other content
 * at an imported version; a Claude Code plugin's format and translation report, and the root
 * LICENSE text (collapsed). Versions: each version's source, its origin (git host, repo and commit,
 * pinned or following a branch; an archive URL; the npm registry) and import time. Inspector: the
 * icon (shown as `<img>` through the kernel route) and basic facts, with the latest version's origin.
 */
export default function AdminCatalogItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  return (
    <AdminGate>
      <DirectoryItemView itemId={itemId} />
    </AdminGate>
  );
}

function DirectoryItemView({ itemId }: { itemId: string }) {
  const t = useTranslations("catalog.admin");
  const td = useTranslations("catalog");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const origin = useOrigin();
  const { state, set } = useLoad(() => getCatalogItem(itemId), [itemId]);
  const sources = useLoad(
    () => listMarketplaces().catch(() => ({ items: [], offline: false })),
    [],
  );
  const sourceLabel = useSourceLabel(
    sources.state.kind === "ready" ? sources.state.data.items : [],
  );
  const [tab, setTab] = useState<Tab>("overview");
  const detail = state.kind === "ready" ? state.data : undefined;
  const item = detail?.item;
  const hasIcon = detail?.hasIcon === true;
  const latestDetail = detail?.versions.find(
    (v) => v.version === item?.latestVersion,
  )?.sourceDetail;

  return (
    <DetailPage
      header={{
        breadcrumb: [{ label: t("title"), href: "/admin/catalog" }],
        title: item ? displayNameOf(item, locale) : itemId,
        ...(item && { count: item.latestVersion, status: <PolicyBadge policy={item.policy} /> }),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: TABS.map((x) => ({ id: x, label: t(`detail.tabs.${x}`) })),
        value: tab,
        onChange: (x) => setTab(x as Tab),
      }}
      {...(item && {
        inspectorTitle: item.name,
        inspector: (
          <Stack gap={12}>
            {hasIcon && <CatalogIcon src={adminIconUrl(item.id)} name={item.name} />}
            <KeyValue
              keyWidth="10ch"
              rows={[
                { k: t("detail.fields.package"), v: item.packageName ?? "—" },
                { k: t("detail.fields.publisher"), v: item.publisher || "—" },
                { k: t("detail.fields.latest"), v: item.latestVersion },
                { k: t("detail.fields.source"), v: sourceLabel(item) },
                ...(latestDetail
                  ? [{ k: t("detail.fields.origin"), v: origin(latestDetail) }]
                  : []),
                { k: t("detail.fields.installs"), v: String(item.installs) },
                { k: t("detail.fields.updated"), v: formatTime(item.updatedAt, locale) },
              ]}
            />
          </Stack>
        ),
      })}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
      ) : detail === undefined ? null : tab === "overview" ? (
        <Overview detail={detail} onChanged={set} />
      ) : (
        <Versions versions={detail.versions} />
      )}
      {item?.description && tab === "overview" && <Text tone="muted">{item.description}</Text>}
      {item && item.deletedAt !== null && <Text tone="warn">{td("admin.detail.deleted")}</Text>}
    </DetailPage>
  );
}

function Overview({
  detail,
  onChanged,
}: {
  detail: CatalogItemDetail;
  onChanged(next: CatalogItemDetail): void;
}) {
  const t = useTranslations("catalog.admin.detail");
  const tp = useTranslations("catalog.policy");
  const tt = useTranslations("catalog.admin.review.translation");
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const item = detail.item;
  const deleted = item.deletedAt !== null;
  const [busy, setBusy] = useState<"policy" | "deploy">();
  const [error, setError] = useState<string>();
  // Versions whose plugin has an extension (only those can be installed on the deployment)
  const withExtension = detail.versions.filter((v) => v.manifest.extension !== undefined);
  const latest = detail.versions.find((v) => v.version === item.latestVersion);
  const [version, setVersion] = useState(withExtension[0]?.version ?? item.latestVersion);
  const [deployed, setDeployed] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const changePolicy = async (policy: CatalogPolicy) => {
    setBusy("policy");
    setError(undefined);
    try {
      const next = await setCatalogPolicy(item.id, policy);
      onChanged({ ...detail, item: { ...item, ...next } });
      toast.success(t("policySaved", { policy: tp(policy) }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const deploy = async () => {
    setBusy("deploy");
    setError(undefined);
    try {
      const p = await installItemToDeployment(item.id, version);
      setDeployed(p.name);
      toast.success(t("deployed", { name: `${p.name} ${p.version}` }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Stack gap={16}>
      {error !== undefined && <FormError message={error} />}
      {item.contentChanged && <Text tone="warn">{t("contentChanged")}</Text>}
      {latest?.sourceFormat === "claude-code" && (
        <Stack direction="row">
          <Badge>{tt("formatClaude")}</Badge>
        </Stack>
      )}
      {latest !== undefined && <Components manifest={latest.manifest} />}
      {latest?.translation != null && <TranslationReportView report={latest.translation} />}
      {latest !== undefined && (
        <LicenseView text={latest.licenseText} truncated={latest.licenseTruncated} />
      )}
      <Card title={t("policyTitle")}>
        <Stack gap={8}>
          <Text variant="small" tone="muted">
            {t("policyHint")}
          </Text>
          <RadioGroup
            label={t("policyTitle")}
            value={item.policy}
            onChange={(v) => void changePolicy(v as CatalogPolicy)}
            disabled={deleted || busy !== undefined}
            options={CATALOG_POLICIES.map((p) => ({ value: p, label: tp(p) }))}
          />
        </Stack>
      </Card>
      {withExtension.length > 0 && !deleted && (
        <Card title={t("deployTitle")}>
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t("deployHint")}
            </Text>
            <Field label={t("deployVersion")}>
              <Select
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                options={withExtension.map((v) => ({ value: v.version, label: v.version }))}
              />
            </Field>
            <Stack direction="row" gap={8} align="center">
              <Button
                loading={busy === "deploy"}
                disabled={busy !== undefined}
                onClick={() => void deploy()}
              >
                {t("deploy")}
              </Button>
              {deployed !== null && (
                <Link href={`/admin/extensions/${encodeURIComponent(deployed)}`}>
                  {t("openExtension")}
                </Link>
              )}
            </Stack>
          </Stack>
        </Card>
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
          await removeCatalogItem(item.id).catch((e: unknown) => {
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
function Components({ manifest }: { manifest: PluginManifest }) {
  const t = useTranslations("catalog.components");
  const tp = useTranslations("extensions");
  const items = useLoad(
    () =>
      listCatalogItems()
        .then((r) => r.items)
        .catch(() => [] as CatalogItem[]),
    [],
  );
  const catalog = items.state.kind === "ready" ? items.state.data : [];
  const ext = manifest.extension?.manifest;
  const skills = manifest.skills ?? [];
  const templates = manifest.connectorTemplates ?? [];
  const deps = manifest.dependencies ?? [];
  const label = (category: string) =>
    tp.has(`category.${category}`) ? tp(`category.${category}`) : category;
  return (
    <Stack gap={16}>
      <ComponentSection title={t("extension")} count={ext ? 1 : 0} empty={t("extensionNone")}>
        {ext && (
          <Card title={t("extensionVersion", { name: ext.name, version: ext.version })}>
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
      <ComponentSection title={t("dependencies")} count={deps.length} empty={t("dependenciesNone")}>
        <Text variant="small" tone="muted">
          {t("dependenciesHint")}
        </Text>
        {deps.map((d) => {
          const found = catalog.find((i) => i.name === d.name);
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
          ) : items.state.kind === "ready" ? (
            <Text key={d.name} tone="warn">
              {t("dependencyNotInCatalog", { name: d.name, range: d.version })}
            </Text>
          ) : (
            // Still loading the catalog: only the name and range
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
  const locale = useLocale();
  const origin = useOrigin();
  const columns: Column<CatalogItemVersion>[] = [
    { key: "version", header: t("version"), cell: (v) => v.version },
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
      cell: (v) => formatTime(v.importedAt, locale),
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
