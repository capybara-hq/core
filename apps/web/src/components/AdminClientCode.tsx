"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  formatBytes,
  KeyValue,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  CLIENT_EXTENSIONS_DEFAULT,
  type DeploymentSettings,
  updateDeploymentSettings,
} from "../lib/admin";
import type { AdminExtension, ClientReportRow } from "../lib/admin-extensions";
import { deploymentSettingsQuery } from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";
import { invalidateClientSets } from "../lib/query/client-extensions";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * 界面代码 on the admin extension detail (client extensions spec §5.4, §10.2, §10.4): whether the
 * extension's client code runs (stopped alone, or with all client code), its build (the package
 * sha256, the client API version, the total size), each file with its size, and the error reports
 * of the current build, newest first. 停用界面代码 adds the extension to the kill switch's
 * per-plugin list (its server side keeps running); 恢复界面代码 takes it out; either reads the list
 * fresh before writing, so a concurrent change to another plugin's entry is kept. Drawn only for an
 * extension with a client build.
 */
export function AdminClientCode({ plugin }: { plugin: AdminExtension }) {
  const t = useTranslations("admin.extensions.clientCode");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  const sq = deploymentSettingsQuery();
  const settings = useQuery({
    ...sq,
    enabled: plugin.client != null,
    retryOnMount: retryOnMountOf(sq.queryKey),
  }).data;
  const killSwitch = settings?.clientExtensions ?? CLIENT_EXTENSIONS_DEFAULT;
  const stopped = killSwitch.disabled.includes(plugin.name);
  // The list is read fresh when writing (another super admin may have changed it since this page
  // read it), then the answer, the settings as they are now, replaces the cached ones
  const write = useAppMutation({
    fn: async (stop: boolean) => {
      const fresh = await qc.fetchQuery({ ...sq, staleTime: 0 });
      const current = (fresh.clientExtensions ?? CLIENT_EXTENSIONS_DEFAULT).disabled;
      const disabled = stop
        ? [...new Set([...current, plugin.name])]
        : current.filter((n) => n !== plugin.name);
      const r = await updateDeploymentSettings({ clientExtensions: { disabled } });
      await invalidateClientSets(qc);
      return r;
    },
    invalidates: () => [],
    onSuccess: (r: DeploymentSettings) => qc.setQueryData(sq.queryKey, r),
  });
  const client = plugin.client;
  if (client == null) return null;
  const total = client.files.reduce((n, f) => n + f.bytes, 0);
  const reports = plugin.clientReports ?? [];

  async function toggle() {
    try {
      await write.mutateAsync(!stopped);
      toast.success(t(stopped ? "resumed" : "stopped", { name: plugin.name }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const fileColumns: Column<{ path: string; bytes: number }>[] = [
    { key: "path", header: t("columns.path"), cell: (f) => f.path },
    { key: "size", header: t("columns.size"), fit: true, cell: (f) => formatBytes(f.bytes) },
  ];
  const reportColumns: Column<ClientReportRow>[] = [
    { key: "kind", header: t("columns.kind"), fit: true, cell: (r) => t(`kind.${r.kind}`) },
    {
      key: "contribution",
      header: t("columns.contribution"),
      tone: "muted",
      fit: true,
      cell: (r) => r.contribution ?? "—",
    },
    {
      key: "where",
      header: t("columns.where"),
      tone: "muted",
      fit: true,
      cell: (r) => r.orgId ?? t("adminPages"),
    },
    { key: "count", header: t("columns.count"), fit: true, cell: (r) => String(r.count) },
    {
      key: "last",
      header: t("columns.last"),
      fit: true,
      cell: (r) => <DateTime value={r.lastAt} />,
    },
    { key: "message", header: t("columns.message"), wrap: true, cell: (r) => r.lastMessage },
  ];
  const state = !killSwitch.enabled ? "allStopped" : stopped ? "stoppedState" : "running";

  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("title")}
      </Text>
      <Text variant="prose" tone={state === "running" ? "ok" : "warn"}>
        {t(state)}
      </Text>
      <KeyValue
        keyWidth="12ch"
        rows={[
          { k: t("build"), v: client.build.slice(0, 12) },
          { k: t("apiVersion"), v: String(client.apiVersion) },
          {
            k: t("total"),
            v: t("totalValue", { files: client.files.length, size: formatBytes(total) }),
          },
        ]}
      />
      <Stack direction="row">
        <Button
          variant={stopped ? "default" : "danger"}
          loading={write.isPending}
          disabled={write.isPending || settings === undefined}
          onClick={() => void toggle()}
        >
          {t(stopped ? "resume" : "stop")}
        </Button>
      </Stack>
      <Text variant="prose" tone="muted">
        {t("stopHint")}
      </Text>
      <DataTable
        label={t("filesTitle")}
        columns={fileColumns}
        rows={client.files}
        rowKey={(f) => f.path}
      />
      <Text variant="small" tone="muted">
        {t("reportsTitle")}
      </Text>
      <DataTable
        label={t("reportsTitle")}
        columns={reportColumns}
        rows={reports}
        rowKey={(r) => `${r.orgId ?? ""}/${r.contribution ?? ""}/${r.kind}`}
        empty={{ title: t("noReports") }}
      />
    </Stack>
  );
}
