"use client";

import {
  Button,
  Card,
  Checkbox,
  type Column,
  DangerConfirm,
  DataTable,
  DetailPage,
  Dialog,
  KeyValue,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ExtensionStatusMark } from "../../../../../../components/AdminExtensionParts";
import { AdminGate } from "../../../../../../components/AdminGate";
import { formatTime } from "../../../../../../components/ApprovalCard";
import { ExtensionDeploymentConfig } from "../../../../../../components/ExtensionDeploymentConfig";
import { FormError } from "../../../../../../components/form-error";
import { PermissionReview } from "../../../../../../components/PermissionReview";
import { Link, useRouter } from "../../../../../../i18n/navigation";
import {
  type AdminExtension,
  approveExtension,
  disableExtension,
  type ExtensionReplica,
  enableExtension,
  getAdminExtension,
  listAdminExtensions,
  replicaSummary,
  reviewSensitive,
  uninstallExtension,
} from "../../../../../../lib/admin-extensions";
import { ApiClientError } from "../../../../../../lib/api";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

const TABS = ["overview", "permissions", "config"] as const;
type Tab = (typeof TABS)[number];

/** 收敛中自动重读的间隔与次数上限（只是浏览器里的轮询）。 */
const POLL_MS = 3000;
const POLL_MAX = 20;

/**
 * `/[locale]/admin/extensions/[name]`: an extension (enterprise admins, DetailPage).
 * - Overview: the desired state and each replica's state (failure reason, heartbeat); enable,
 *   disable (confirmed, with the drain time limit), upgrade (to the install wizard), uninstall (must
 *   be disabled first, confirmed by typing its name). Built-in and config-declared extensions don't
 *   offer these and say why (C14 / C15).
 * - Permissions: the same review component as the install confirmation; approvable while pending
 *   (sensitive items must be acknowledged first); read-only for built-in extensions, marked
 *   pre-approved.
 * - Config: the deployment config (sources read-only, secrets can only be set or cleared, hot fields
 *   apply at once, the others reload after saving).
 * Actions only write the desired state and return; the page re-reads while the state is converging.
 */
export default function ExtensionDetailPage() {
  const { name } = useParams<{ name: string }>();
  return (
    <AdminGate>
      <ExtensionDetail name={decodeURIComponent(name)} />
    </AdminGate>
  );
}

function ExtensionDetail({ name }: { name: string }) {
  const t = useTranslations("admin.extensions");
  const errorMessage = useErrorMessage();
  const { state, reload, set } = useLoad(listAdminExtensions, [name]);
  const [tab, setTab] = useState<Tab>("overview");
  const [polls, setPolls] = useState(0);
  const data = state.kind === "ready" ? state.data : undefined;
  const plugin = data?.extensions.find((p) => p.name === name);
  const replace = (next: AdminExtension) => {
    if (data)
      set({ ...data, extensions: data.extensions.map((p) => (p.name === next.name ? next : p)) });
    setPolls(0);
  };
  const moving = plugin?.status === "converging" || plugin?.status === "pending_migration";
  // 收敛中：只轮询这一个插件（`GET /:name`）；轮询出错时保留上一次的数据，下一轮再试
  useEffect(() => {
    if (!moving || polls >= POLL_MAX) return;
    let disposed = false;
    const timer = setTimeout(() => {
      getAdminExtension(name).then(
        (next) => {
          if (disposed || !data) return;
          set({
            ...data,
            extensions: data.extensions.map((p) => (p.name === next.name ? next : p)),
          });
          setPolls((n) => n + 1);
        },
        () => {
          if (!disposed) setPolls((n) => n + 1);
        },
      );
    }, POLL_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [moving, polls, name, data, set]);

  return (
    <DetailPage
      header={{
        parent: { label: t("title"), href: "/admin/extensions" },
        title: name,
        ...(plugin && {
          count: plugin.version,
          status: <ExtensionStatusMark status={plugin.status} />,
        }),
      }}
      tabs={{
        label: t("detail.tabsLabel"),
        items: TABS.map((x) => ({
          id: x,
          label: t(`detail.tabs.${x}`),
          ...(x === "permissions" && plugin?.status === "pending_approval" && { alert: true }),
        })),
        value: tab,
        onChange: (x) => setTab(x as Tab),
      }}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
      ) : plugin === undefined || data === undefined ? (
        <Text tone="muted">{t("detail.notFound")}</Text>
      ) : tab === "overview" ? (
        <Overview
          plugin={plugin}
          drainSeconds={data.drainSeconds}
          moving={moving}
          onChanged={replace}
          onRefresh={reload}
        />
      ) : tab === "permissions" ? (
        <Permissions plugin={plugin} onChanged={replace} onRefresh={reload} />
      ) : (
        <ExtensionDeploymentConfig name={plugin.name} drainSeconds={data.drainSeconds} />
      )}
    </DetailPage>
  );
}

function Overview({
  plugin,
  drainSeconds,
  moving,
  onChanged,
  onRefresh,
}: {
  plugin: AdminExtension;
  drainSeconds: number;
  moving: boolean;
  onChanged(next: AdminExtension): void;
  onRefresh(): void;
}) {
  const t = useTranslations("admin.extensions");
  const locale = useLocale();
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<"disable" | "uninstall" | null>(null);
  const installed = plugin.source === "install";
  const desiredState = plugin.desired?.state;
  const { failed } = replicaSummary(plugin);
  /** 原因码 → 界面文案（没有译文的码原样显示）。 */
  const reasonText = (code: string | null): string | null =>
    code === null || code === ""
      ? null
      : t.has(`detail.replicaReason.${code}`)
        ? t(`detail.replicaReason.${code}`)
        : code;

  const run = async (op: "enable" | "disable") => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await (op === "enable"
        ? enableExtension(plugin.name)
        : disableExtension(plugin.name));
      onChanged(next);
      toast.success(t(`detail.done.${op}`));
      setConfirm(null);
    } catch (e) {
      setError(errorMessage(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<ExtensionReplica>[] = [
    { key: "replica", header: t("detail.replicaColumns.replica"), cell: (r) => r.replicaId },
    {
      key: "version",
      header: t("detail.replicaColumns.version"),
      tone: "muted",
      cell: (r) =>
        r.servingVersion ? (
          <Stack gap={4}>
            <Text>{r.version}</Text>
            <Text variant="small" tone="muted">
              {t("detail.stillServing", { version: r.servingVersion })}
            </Text>
          </Stack>
        ) : (
          r.version
        ),
    },
    {
      key: "state",
      header: t("detail.replicaColumns.state"),
      cell: (r) => {
        const label = t.has(`detail.replicaState.${r.state}`)
          ? t(`detail.replicaState.${r.state}`)
          : r.state;
        return r.state === "failed" ? <Text tone="fail">{label}</Text> : label;
      },
    },
    {
      key: "reason",
      header: t("detail.replicaColumns.reason"),
      tone: "muted",
      cell: (r) =>
        [reasonText(r.reason), r.detail].filter((s) => s !== null && s !== "").join(" · ") || "—",
    },
    {
      key: "heartbeat",
      header: t("detail.replicaColumns.heartbeat"),
      tone: "muted",
      cell: (r) => formatTime(r.heartbeatAt, locale),
    },
  ];

  return (
    <Stack gap={16}>
      {plugin.error !== undefined && (
        <FormError message={t("detail.packageError", { error: plugin.error })} />
      )}
      <KeyValue
        keyWidth="12ch"
        rows={[
          { k: t("detail.fields.source"), v: t(`source.${plugin.source}`) },
          { k: t("detail.fields.version"), v: plugin.version },
          {
            k: t("detail.fields.desired"),
            v:
              desiredState === undefined
                ? t("detail.desired.always")
                : t(`detail.desired.${desiredState}`),
          },
          ...(plugin.sha256 !== null
            ? [{ k: t("detail.fields.sha"), v: plugin.sha256.slice(0, 16) }]
            : []),
        ]}
      />
      {plugin.source === "builtin" && <Text tone="muted">{t("detail.builtinNote")}</Text>}
      {plugin.source === "config" && <Text tone="muted">{t("detail.configNote")}</Text>}
      {installed && (
        <Stack gap={8}>
          <Stack direction="row" gap={8}>
            {desiredState === "disabled" ? (
              <Button variant="primary" loading={busy} onClick={() => void run("enable")}>
                {t("detail.actions.enable")}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => setConfirm("disable")}>
                {t("detail.actions.disable")}
              </Button>
            )}
            <Link href={`/admin/extensions/install?upgrade=${encodeURIComponent(plugin.name)}`}>
              {t("detail.actions.upgrade")}
            </Link>
            {desiredState === "disabled" && plugin.removable && (
              <Button variant="danger" disabled={busy} onClick={() => setConfirm("uninstall")}>
                {t("detail.actions.uninstall")}
              </Button>
            )}
          </Stack>
          {desiredState !== "disabled" && (
            <Text variant="small" tone="muted">
              {t("detail.uninstallNeedsDisable")}
            </Text>
          )}
        </Stack>
      )}
      {error !== undefined && <FormError message={error} />}
      {moving && (
        <Stack direction="row" gap={8} align="center">
          <Text tone="muted">{t("detail.converging")}</Text>
          <Button size={24} onClick={onRefresh}>
            {t("detail.refresh")}
          </Button>
        </Stack>
      )}
      {failed.length > 0 && (
        <Card tone="danger">
          <Stack gap={4}>
            {failed.map((r) => (
              <Stack key={r.replicaId} gap={4}>
                <Text tone="fail">
                  {t("detail.failedReplica", {
                    replica: r.replicaId,
                    reason: reasonText(r.reason) ?? "—",
                  })}
                </Text>
                {r.servingVersion && (
                  <Text variant="small" tone="muted">
                    {t("detail.stillServing", { version: r.servingVersion })}
                  </Text>
                )}
                {r.detail !== null && r.detail !== "" && (
                  <Text variant="small" tone="fail">
                    {r.detail}
                  </Text>
                )}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("detail.replicasTitle")}
        </Text>
        <DataTable
          label={t("detail.replicasTitle")}
          columns={columns}
          rows={plugin.replicas}
          rowKey={(r) => r.replicaId}
          empty={{ title: t("detail.noReplicas") }}
        />
      </Stack>
      <Dialog
        open={confirm === "disable"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("detail.disableConfirm.title", { name: plugin.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("wizard.cancel")}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void run("disable")}>
              {t("detail.disableConfirm.confirm")}
            </Button>
          </>
        }
      >
        <Stack gap={8}>
          <Text>{t("detail.disableConfirm.hint")}</Text>
          <Text tone="warn">{t("detail.drainHint", { seconds: drainSeconds })}</Text>
        </Stack>
      </Dialog>
      <DangerConfirm
        open={confirm === "uninstall"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("detail.uninstallConfirm.title", { name: plugin.name })}
        description={t("detail.uninstallConfirm.hint")}
        confirmName={plugin.name}
        confirmLabel={t("detail.uninstallConfirm.confirm")}
        onConfirm={async () => {
          await uninstallExtension(plugin.name);
          toast.success(t("detail.done.uninstall", { name: plugin.name }));
          router.push("/admin/extensions");
        }}
      />
    </Stack>
  );
}

function Permissions({
  plugin,
  onChanged,
  onRefresh,
}: {
  plugin: AdminExtension;
  onChanged(next: AdminExtension): void;
  onRefresh(): void;
}) {
  const t = useTranslations("admin.extensions.approve");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string }>();
  const builtin = plugin.source === "builtin";
  // 待批准：状态为待批准，或权限超出快照（状态被失败等更高优先级的状态盖住时也能批准）
  const pending = plugin.status === "pending_approval" || plugin.added.length > 0;
  const sensitive = reviewSensitive(plugin);

  const approve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await approveExtension(plugin.name, {
        sha256: plugin.sha256,
        reviewHash: plugin.reviewHash,
      });
      onChanged(next);
      toast.success(t("done"));
    } catch (e) {
      const code = e instanceof ApiClientError ? e.code : "unknown";
      setError({
        code,
        message: code === "extension.approval_stale" ? t("stale") : errorMessage(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={16}>
      {builtin ? (
        <Text tone="muted">{t("builtin")}</Text>
      ) : plugin.snapshot !== null ? (
        <Text tone="muted">
          {t("approved", {
            version: plugin.snapshot.version,
            at: formatTime(plugin.snapshot.approvedAt, locale),
            source: t(`via.${plugin.snapshot.source}`),
          })}
        </Text>
      ) : (
        <Text tone="muted">{t("notApproved")}</Text>
      )}
      <PermissionReview
        plugin={plugin.name}
        groups={plugin.permissions}
        added={builtin ? [] : plugin.addedItems}
        removed={builtin ? [] : plugin.removed}
        warnings={plugin.warnings}
      />
      {pending && !builtin && (
        <Card tone="accent" title={t("title")}>
          <Stack gap={12}>
            <Text tone="muted">{t("hint")}</Text>
            {sensitive && <Checkbox checked={ack} onChange={setAck} label={t("ack")} />}
            {error !== undefined && (
              <Stack gap={8}>
                <FormError message={error.message} />
                {error.code === "extension.approval_stale" && (
                  <Stack direction="row">
                    <Button
                      size={24}
                      onClick={() => {
                        setError(undefined);
                        setAck(false);
                        onRefresh();
                      }}
                    >
                      {t("refresh")}
                    </Button>
                  </Stack>
                )}
              </Stack>
            )}
            <Stack direction="row">
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || (sensitive && !ack)}
                onClick={() => void approve()}
              >
                {t("submit")}
              </Button>
            </Stack>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
