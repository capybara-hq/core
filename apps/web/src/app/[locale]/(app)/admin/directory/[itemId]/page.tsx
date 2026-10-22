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
  DirectoryIcon,
  PolicyBadge,
  useKindLabel,
  useSourceLabel,
} from "../../../../../../components/DirectoryParts";
import { FormError } from "../../../../../../components/form-error";
import { Link, useRouter } from "../../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../../lib/api";
import {
  adminIconUrl,
  DIRECTORY_POLICIES,
  type DirectoryItemDetail,
  type DirectoryItemVersion,
  type DirectoryPolicy,
  displayNameOf,
  getDirectoryItem,
  installItemToDeployment,
  listCatalogSources,
  removeDirectoryItem,
  setDirectoryPolicy,
} from "../../../../../../lib/directory";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

const TABS = ["overview", "versions"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/[locale]/admin/directory/[itemId]`：目录条目详情（企业管理员，DetailPage）。概要：策略切换（允许 / 需审批 /
 * 禁用）、安装的组织数；插件条目可以选版本「装到部署」（之后在插件后台批准与启用）；删除条目（输入名字确认）。
 * 版本：各版本的来源与导入时间。Inspector：图标（连接器模板 / 应用，经内核路由以 `<img>` 显示）与基本信息。
 */
export default function DirectoryItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  return (
    <AdminGate>
      <DirectoryItemView itemId={itemId} />
    </AdminGate>
  );
}

function DirectoryItemView({ itemId }: { itemId: string }) {
  const t = useTranslations("directory.admin");
  const td = useTranslations("directory");
  const locale = useLocale();
  const kindLabel = useKindLabel();
  const errorMessage = useErrorMessage();
  const { state, set } = useLoad(() => getDirectoryItem(itemId), [itemId]);
  const sources = useLoad(
    () => listCatalogSources().catch(() => ({ items: [], offline: false })),
    [],
  );
  const sourceLabel = useSourceLabel(
    sources.state.kind === "ready" ? sources.state.data.items : [],
  );
  const [tab, setTab] = useState<Tab>("overview");
  const detail = state.kind === "ready" ? state.data : undefined;
  const item = detail?.item;
  const hasIcon = item?.kind === "connector-template" || item?.kind === "app";

  return (
    <DetailPage
      header={{
        parent: { label: t("title"), href: "/admin/directory" },
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
            {hasIcon && <DirectoryIcon src={adminIconUrl(item.id)} name={item.name} />}
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
  detail: DirectoryItemDetail;
  onChanged(next: DirectoryItemDetail): void;
}) {
  const t = useTranslations("directory.admin.detail");
  const tp = useTranslations("directory.policy");
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

  const changePolicy = async (policy: DirectoryPolicy) => {
    setBusy("policy");
    setError(undefined);
    try {
      const next = await setDirectoryPolicy(item.id, policy);
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
            onChange={(v) => void changePolicy(v as DirectoryPolicy)}
            disabled={deleted || busy !== undefined}
            options={DIRECTORY_POLICIES.map((p) => ({ value: p, label: tp(p) }))}
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
                <Link href={`/admin/plugins/${encodeURIComponent(deployed)}`}>
                  {t("openPlugin")}
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
          await removeDirectoryItem(item.id).catch((e: unknown) => {
            throw new Error(errorMessage(e));
          });
          toast.success(t("deletedToast", { name: item.name }));
          router.push("/admin/directory");
        }}
      />
    </Stack>
  );
}

function Versions({ versions }: { versions: DirectoryItemVersion[] }) {
  const t = useTranslations("directory.admin.detail.versionColumns");
  const tv = useTranslations("directory.versionSource");
  const locale = useLocale();
  const columns: Column<DirectoryItemVersion>[] = [
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
