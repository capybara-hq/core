"use client";

import {
  Button,
  Card,
  Checkbox,
  type Column,
  DangerConfirm,
  DataTable,
  DateTime,
  DetailPage,
  Dialog,
  formatDateTime,
  KeyValue,
  LinkButton,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ExtensionStatusMark } from "../../../../../components/AdminExtensionParts";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { ExtensionDeploymentConfig } from "../../../../../components/ExtensionDeploymentConfig";
import { FormError } from "../../../../../components/form-error";
import { NoAccess } from "../../../../../components/NoAccess";
import { PermissionReview } from "../../../../../components/PermissionReview";
import { usePagePath } from "../../../../../components/shell/path";
import { useRouter } from "../../../../../i18n/navigation";
import {
  type AdminExtension,
  approveExtension,
  disableExtension,
  displaySource,
  type ExtensionReplica,
  enableExtension,
  replicaSummary,
  reviewSensitive,
  uninstallExtension,
} from "../../../../../lib/admin-extensions";
import { ApiClientError } from "../../../../../lib/api";
import { extensionLabel, labelLocale } from "../../../../../lib/extension-label";
import {
  adminExtensionQuery,
  adminExtensionsQuery,
  extensionChangeKeys,
} from "../../../../../lib/query/admin";
import { useAppMutation } from "../../../../../lib/query/define";
import { keys } from "../../../../../lib/query/keys";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

type ExtensionList = { extensions: AdminExtension[]; drainSeconds: number };

const TABS = ["overview", "permissions", "config"] as const;
type Tab = (typeof TABS)[number];

/** 收敛中自动重读的间隔与次数上限（只是浏览器里的轮询）。 */
const POLL_MS = 3000;
const POLL_MAX = 20;

/**
 * `/admin/extensions/[name]`: an extension (enterprise admins, DetailPage).
 * - Overview: the desired state and each replica's state (failure reason, heartbeat); enable,
 *   disable (confirmed, with the drain time limit), upgrade (to the install wizard), uninstall (must
 *   be disabled first, confirmed by typing its name). Built-in and config-declared extensions don't
 *   offer these and say why (C14 / C15).
 * - Permissions: the same review component as the install confirmation; approvable while pending
 *   (sensitive items must be acknowledged first); read-only for built-in extensions, marked
 *   pre-approved.
 * - Config: the deployment config (sources read-only, secrets can only be set or cleared, hot fields
 *   apply at once, the others reload after saving); a pending-config extension opens on it, with
 *   the missing fields listed.
 * Actions only write the desired state and return; the page re-reads while the state is converging.
 * From the query cache (the layout prefetched the list and the config on a first load). An action's
 * answer is the extension as it is now: it replaces that one in the cached list, and what an
 * extension brings to the current org (its readiness among them) is read again. While it converges
 * only this extension is polled (`refetchInterval`), each answer written into the list.
 */
export default function ExtensionDetailView({ name }: { name: string }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <ExtensionDetail name={name} orgId={gate.me.currentOrgId} />;
}

function ExtensionDetail({ name, orgId }: { name: string; orgId: string | null }) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.extensions");
  const qc = useQueryClient();
  const read = usePageQuery(adminExtensionsQuery());
  const tabs = (tab: Tab, onChange: (x: Tab) => void, alert = false) => ({
    label: t("detail.tabsLabel"),
    items: TABS.map((x) => ({
      id: x,
      label: t(`detail.tabs.${x}`),
      ...(x === "permissions" && alert && { alert: true }),
    })),
    value: tab,
    onChange: (x: string) => onChange(x as Tab),
  });
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    // The extension may be cached already (its poll entry): it opens on the tab its status picks.
    const known = qc.getQueryData<AdminExtension>(adminExtensionQuery(name).queryKey);
    const tab: Tab = known?.status === "pending_config" ? "config" : "overview";
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "extensions", href: "/admin/extensions" }, { label: name }],
          title: "",
        }}
        tabs={tabs(tab, () => {})}
        loading={{
          content:
            tab === "config"
              ? // The config tab: its hint, then the form's fields and its save button.
                [{ kind: "lines", lines: 2 }, { kind: "buttons" }]
              : // The overview of an installed extension: its facts (source, version, desired
                // state, digest) in two columns, its lifecycle buttons with their note, and the
                // replicas table under its title.
                [
                  { kind: "key-value", rows: 4, columns: 2 },
                  { kind: "buttons", count: 2, help: true },
                  {
                    kind: "table",
                    title: t("detail.replicasTitle"),
                    label: t("detail.replicasTitle"),
                    columns: (["replica", "version", "state", "reason", "heartbeat"] as const).map(
                      (key) => ({
                        key,
                        header: t(`detail.replicaColumns.${key}`),
                        cell: () => null,
                      }),
                    ),
                  },
                ],
        }}
      />
    );
  }
  return <Detail name={name} orgId={orgId} data={read.data} tabs={tabs} />;
}

function Detail({
  name,
  orgId,
  data,
  tabs,
}: {
  name: string;
  orgId: string | null;
  data: ExtensionList;
  tabs: (
    tab: Tab,
    onChange: (x: Tab) => void,
    alert?: boolean,
  ) => Parameters<typeof DetailPage>[0]["tabs"];
}) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.extensions");
  const qc = useQueryClient();
  const lang = labelLocale(useLocale());
  const plugin = data.extensions.find((p) => p.name === name);
  // The title shows the display name; the id (also the URL segment) is muted meta in the overview.
  const label = plugin ? extensionLabel(plugin, lang) : name;
  // An extension waiting for config opens on its config form.
  const [tab, setTab] = useState<Tab>(() =>
    plugin?.status === "pending_config" ? "config" : "overview",
  );
  const [polls, setPolls] = useState(0);
  const listKey = adminExtensionsQuery().queryKey;
  // The extension as it is now replaces that one in the cached list.
  const intoList = (next: AdminExtension) =>
    qc.setQueryData<ExtensionList>(listKey, (d) =>
      d === undefined
        ? d
        : { ...d, extensions: d.extensions.map((p) => (p.name === next.name ? next : p)) },
    );
  const replace = (next: AdminExtension) => {
    intoList(next);
    qc.setQueryData(adminExtensionQuery(name).queryKey, next);
    setPolls(0);
  };
  // Reads the list again (an approval gone stale, a converging extension).
  const refresh = () => void qc.invalidateQueries({ queryKey: listKey });
  const moving = plugin?.status === "converging" || plugin?.status === "pending_migration";
  // Converging: poll only this extension (`GET /:name`) every POLL_MS, at most POLL_MAX times; it
  // starts from the list's entry, so the first read waits a period. A failed poll keeps the last
  // data and the next round tries again.
  const one = adminExtensionQuery(name);
  const poll = useQuery({
    ...one,
    enabled: moving && plugin !== undefined,
    ...(plugin !== undefined && { initialData: plugin }),
    retry: false,
    refetchInterval: moving && polls < POLL_MAX ? POLL_MS : false,
    refetchIntervalInBackground: true,
  });
  // Only real reads count towards the budget: a fetch that answered or failed. The list entry it
  // starts from and an action's answer written into it (`manual`) are no polls.
  const pollHash = JSON.stringify(one.queryKey);
  // ssr-exempt: live updates after first paint (the extension is still converging)
  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || JSON.stringify(event.query.queryKey) !== pollHash) return;
        const a = event.action;
        if ((a.type === "success" && a.manual !== true) || a.type === "error")
          setPolls((n) => n + 1);
      }),
    [qc, pollHash],
  );
  // A poll's answer newer than the list's goes into the list (an older one never overwrites it).
  const pollAt = poll.dataUpdatedAt;
  useEffect(() => {
    const next = poll.data;
    const listAt = qc.getQueryState(listKey)?.dataUpdatedAt ?? 0;
    if (next !== undefined && next !== plugin && pollAt > listAt) intoList(next);
  });
  const changed = { orgId, onChanged: replace, onRefresh: refresh };

  return (
    <DetailPage
      header={{
        path: [...scope, { label: "extensions", href: "/admin/extensions" }, { label }],
        title: label,
        ...(plugin && {
          count: versionLabel(plugin.version),
          status: <ExtensionStatusMark status={plugin.status} />,
        }),
      }}
      tabs={tabs(tab, setTab, plugin?.status === "pending_approval")}
    >
      {plugin === undefined ? (
        <Text tone="muted">{t("detail.notFound")}</Text>
      ) : tab === "overview" ? (
        <Overview plugin={plugin} drainSeconds={data.drainSeconds} moving={moving} {...changed} />
      ) : tab === "permissions" ? (
        <Permissions plugin={plugin} {...changed} />
      ) : (
        <ExtensionDeploymentConfig
          name={name}
          drainSeconds={data.drainSeconds}
          pending={plugin.status === "pending_config"}
          // The extension's state (pending config) and the org's readiness may change with it.
          onChanged={() => {
            for (const queryKey of [listKey, ...extensionChangeKeys(orgId)])
              void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </DetailPage>
  );
}

function Overview({
  plugin,
  drainSeconds,
  moving,
  orgId,
  onChanged,
  onRefresh,
}: {
  plugin: AdminExtension;
  drainSeconds: number;
  moving: boolean;
  orgId: string | null;
  onChanged(next: AdminExtension): void;
  onRefresh(): void;
}) {
  const t = useTranslations("admin.extensions");
  const lang = labelLocale(useLocale());
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<"disable" | "uninstall" | null>(null);
  const installed = plugin.source === "install";
  const desiredState = plugin.desired?.state;
  const { failed } = replicaSummary(plugin);
  const lifecycle = useAppMutation({
    fn: (op: "enable" | "disable") =>
      op === "enable" ? enableExtension(plugin.name) : disableExtension(plugin.name),
    invalidates: () => extensionChangeKeys(orgId),
    onSuccess: onChanged,
  });
  // Gone from the list: the list and what the extension brought are read again.
  const uninstall = useAppMutation({
    fn: uninstallExtension,
    invalidates: () => [keys.deployment().extensions(), ...extensionChangeKeys(orgId)],
  });
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
      await lifecycle.mutateAsync(op);
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
            <Text>{versionLabel(r.version)}</Text>
            <Text variant="small" tone="muted">
              {t("detail.stillServing", { version: versionLabel(r.servingVersion) })}
            </Text>
          </Stack>
        ) : (
          versionLabel(r.version)
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
      cell: (r) => <DateTime value={r.heartbeatAt} />,
    },
  ];

  return (
    <Stack gap={16}>
      {plugin.error !== undefined && (
        <FormError message={t("detail.packageError", { error: plugin.error })} />
      )}
      <KeyValue
        columns={2}
        rows={[
          ...(plugin.displayName ? [{ k: t("detail.fields.id"), v: plugin.name }] : []),
          { k: t("detail.fields.source"), v: t(`source.${displaySource(plugin)}`) },
          { k: t("detail.fields.version"), v: versionLabel(plugin.version) },
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
      {plugin.required && (
        <Text variant="prose" tone="muted">
          {t("detail.requiredNote")}
        </Text>
      )}
      {plugin.source === "config" && (
        <Text variant="prose" tone="muted">
          {t("detail.configNote")}
        </Text>
      )}
      {installed && (
        <Stack gap={8}>
          <Stack direction="row" gap={8}>
            {desiredState === "disabled" ? (
              <Button variant="primary" loading={busy} onClick={() => void run("enable")}>
                {t("detail.actions.enable")}
              </Button>
            ) : (
              !plugin.required && (
                <Button disabled={busy} onClick={() => setConfirm("disable")}>
                  {t("detail.actions.disable")}
                </Button>
              )
            )}
            <LinkButton
              variant="secondary"
              href={`/admin/extensions/install?upgrade=${encodeURIComponent(plugin.name)}`}
            >
              {t("detail.actions.upgrade")}
            </LinkButton>
            {desiredState === "disabled" && plugin.removable && (
              <Button variant="danger" disabled={busy} onClick={() => setConfirm("uninstall")}>
                {t("detail.actions.uninstall")}
              </Button>
            )}
          </Stack>
          {desiredState !== "disabled" && !plugin.required && (
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
          <Button density="dense" onClick={onRefresh}>
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
                    {t("detail.stillServing", { version: versionLabel(r.servingVersion) })}
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
        title={t("detail.disableConfirm.title", { name: extensionLabel(plugin, lang) })}
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
          <Text variant="prose">{t("detail.disableConfirm.hint")}</Text>
          <Text variant="prose" tone="warn">
            {t("detail.drainHint", { seconds: drainSeconds })}
          </Text>
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
          await uninstall.mutateAsync(plugin.name);
          toast.success(t("detail.done.uninstall", { name: plugin.name }));
          router.push("/admin/extensions");
        }}
      />
    </Stack>
  );
}

function Permissions({
  plugin,
  orgId,
  onChanged,
  onRefresh,
}: {
  plugin: AdminExtension;
  orgId: string | null;
  onChanged(next: AdminExtension): void;
  onRefresh(): void;
}) {
  const t = useTranslations("admin.extensions.approve");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string }>();
  // 待批准：状态为待批准，或权限超出快照（状态被失败等更高优先级的状态盖住时也能批准）
  const pending = plugin.status === "pending_approval" || plugin.added.length > 0;
  const sensitive = reviewSensitive(plugin);
  const approval = useAppMutation({
    fn: (body: { sha256: string | null; reviewHash: string }) =>
      approveExtension(plugin.name, body),
    invalidates: () => extensionChangeKeys(orgId),
    onSuccess: onChanged,
  });

  const approve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await approval.mutateAsync({ sha256: plugin.sha256, reviewHash: plugin.reviewHash });
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
      {plugin.snapshot !== null ? (
        <Text tone="muted">
          {t("approved", {
            version: versionLabel(plugin.snapshot.version),
            at: formatDateTime(plugin.snapshot.approvedAt),
            source: t(`via.${plugin.snapshot.source}`),
          })}
        </Text>
      ) : (
        <Text tone="muted">{t("notApproved")}</Text>
      )}
      <PermissionReview
        plugin={plugin.name}
        groups={plugin.permissions}
        added={plugin.addedItems}
        removed={plugin.removed}
        warnings={plugin.warnings}
      />
      {pending && (
        <Card tone="accent" title={t("title")}>
          <Stack gap={12}>
            <Text variant="prose" tone="muted">
              {t("hint")}
            </Text>
            {sensitive && <Checkbox checked={ack} onChange={setAck} label={t("ack")} />}
            {error !== undefined && (
              <Stack gap={8}>
                <FormError message={error.message} />
                {error.code === "extension.approval_stale" && (
                  <Stack direction="row">
                    <Button
                      density="dense"
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
