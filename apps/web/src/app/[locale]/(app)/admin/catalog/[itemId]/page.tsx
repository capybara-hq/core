"use client";

import {
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
  PolicyBadge,
  useKindLabel,
  useSourceLabel,
} from "../../../../../../components/CatalogParts";
import { FormError } from "../../../../../../components/form-error";
import { Link, useRouter } from "../../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../../lib/api";
import {
  adminIconUrl,
  CATALOG_POLICIES,
  type CatalogItemDetail,
  type CatalogItemVersion,
  type CatalogPolicy,
  displayNameOf,
  getCatalogItem,
  installItemToDeployment,
  listMarketplaces,
  removeCatalogItem,
  setCatalogPolicy,
} from "../../../../../../lib/catalog";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

const TABS = ["overview", "versions"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/[locale]/admin/catalog/[itemId]`: a catalog item (enterprise admins, DetailPage). Overview: the
 * policy switch (allow / needs approval / disabled) and the number of orgs that installed it; an
 * extension item can install a chosen version on the deployment (then approved and enabled in the
 * extension admin); deleting the item (confirmed by typing its name). Versions: each version's
 * source and import time. Inspector: the icon (connector templates / plugins, shown as `<img>`
 * through the kernel route) and basic facts.
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
  const kindLabel = useKindLabel();
  const errorMessage = useErrorMessage();
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

  return (
    <DetailPage
      header={{
        parent: { label: t("title"), href: "/admin/catalog" },
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
                { k: t("detail.fields.kind"), v: kindLabel(item.kind) },
                { k: t("detail.fields.package"), v: item.packageName },
                { k: t("detail.fields.publisher"), v: item.publisher || "—" },
                { k: t("detail.fields.latest"), v: item.latestVersion },
                { k: t("detail.fields.source"), v: sourceLabel(item) },
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
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const item = detail.item;
  const deleted = item.deletedAt !== null;
  const [busy, setBusy] = useState<"policy" | "deploy">();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(item.latestVersion);
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
      {item.kind === "plugin" && !deleted && (
        <Card title={t("deployTitle")}>
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t("deployHint")}
            </Text>
            <Field label={t("deployVersion")}>
              <Select
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                options={item.versions.map((v) => ({ value: v, label: v }))}
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

function Versions({ versions }: { versions: CatalogItemVersion[] }) {
  const t = useTranslations("catalog.admin.detail.versionColumns");
  const tv = useTranslations("catalog.versionSource");
  const locale = useLocale();
  const columns: Column<CatalogItemVersion>[] = [
    { key: "version", header: t("version"), cell: (v) => v.version },
    { key: "source", header: t("source"), cell: (v) => tv(v.source) },
    { key: "ref", header: t("ref"), tone: "muted", cell: (v) => v.sourceRef },
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
