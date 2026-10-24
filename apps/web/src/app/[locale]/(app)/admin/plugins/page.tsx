"use client";

import {
  Badge,
  type Column,
  DataTable,
  ListPage,
  RadioGroup,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../components/AdminGate";
import { PluginStatusMark } from "../../../../../components/AdminPluginParts";
import { useAdminParent } from "../../../../../components/admin-nav";
import { useRouter } from "../../../../../i18n/navigation";
import {
  type AdminPlugin,
  listAdminPlugins,
  PLUGIN_SOURCES,
  PLUGIN_STATUSES,
  type PluginSource,
  type PluginStatus,
  replicaSummary,
} from "../../../../../lib/admin-plugins";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/admin/plugins`：部署上的全部插件（企业管理员，ListPage）。列：名称、版本、来源（内置 / 配置 / 安装）、
 * 状态、敏感、副本是否一致；Rail 按状态与来源筛选。打开一行进详情；页头「安装插件」进安装向导。
 */
export default function AdminPluginsPage() {
  return (
    <AdminGate>
      <AdminPlugins />
    </AdminGate>
  );
}

function AdminPlugins() {
  const t = useTranslations("admin.plugins");
  const parent = useAdminParent();
  const router = useRouter();
  const { state, reload } = useLoad(listAdminPlugins, []);
  const [status, setStatus] = useState<PluginStatus | "">("");
  const [source, setSource] = useState<PluginSource | "">("");
  const all = state.kind === "ready" ? state.data.plugins : [];
  const rows = all.filter(
    (p) => (status === "" || p.status === status) && (source === "" || p.source === source),
  );

  const columns: Column<AdminPlugin>[] = [
    { key: "name", header: t("columns.name"), cell: (p) => p.name },
    { key: "version", header: t("columns.version"), tone: "muted", cell: (p) => p.version },
    { key: "source", header: t("columns.source"), cell: (p) => t(`source.${p.source}`) },
    {
      key: "status",
      header: t("columns.status"),
      cell: (p) => <PluginStatusMark status={p.status} />,
    },
    {
      key: "sensitive",
      header: t("columns.sensitive"),
      cell: (p) => (p.sensitive ? <Badge tone="accent">{t("sensitive")}</Badge> : "—"),
    },
    {
      key: "replicas",
      header: t("columns.replicas"),
      cell: (p) => {
        const r = replicaSummary(p);
        if (r.total === 0) return <Text tone="muted">{t("replicas.none")}</Text>;
        return r.consistent ? (
          t("replicas.consistent", { n: r.total })
        ) : (
          <Text tone="warn">{t("replicas.diverged", { n: r.total })}</Text>
        );
      },
    },
  ];

  return (
    <ListPage
      header={{
        parent,
        title: t("title"),
        count: String(all.length),
        actions: [{ label: t("install"), variant: "primary", href: "/admin/plugins/install" }],
      }}
      rail={
        <Stack gap={16}>
          <RadioGroup
            label={t("filters.status")}
            value={status}
            onChange={(v) => setStatus(v as PluginStatus | "")}
            options={[
              { value: "", label: t("filters.allStatuses") },
              ...PLUGIN_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
            ]}
          />
          <RadioGroup
            label={t("filters.source")}
            value={source}
            onChange={(v) => setSource(v as PluginSource | "")}
            options={[
              { value: "", label: t("filters.allSources") },
              ...PLUGIN_SOURCES.map((s) => ({ value: s, label: t(`source.${s}`) })),
            ]}
          />
        </Stack>
      }
    >
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(p) => p.name}
          state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
          error={{ code: state.kind === "error" ? state.code : "unknown", onRetry: reload }}
          empty={{ title: t("empty") }}
          {...(all.length > 0 && {
            noResults: {
              description: t("noResults"),
              onClear: () => {
                setStatus("");
                setSource("");
              },
            },
          })}
          onOpen={(p) => router.push(`/admin/plugins/${encodeURIComponent(p.name)}`)}
          rowLabel={(p) => p.name}
        />
      </Stack>
    </ListPage>
  );
}
