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
import { ExtensionStatusMark } from "../../../../../components/AdminExtensionParts";
import { AdminGate } from "../../../../../components/AdminGate";
import { useAdminParent } from "../../../../../components/admin-nav";
import { useRouter } from "../../../../../i18n/navigation";
import {
  type AdminExtension,
  EXTENSION_SOURCES,
  EXTENSION_STATUSES,
  type ExtensionSource,
  type ExtensionStatus,
  listAdminExtensions,
  replicaSummary,
} from "../../../../../lib/admin-extensions";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/admin/extensions`: every extension on the deployment (enterprise admins, ListPage).
 * Columns: name, version, source (built-in / config / installed), status, sensitive, whether the
 * replicas agree; the Rail filters by status and source. A row opens the detail page; "Install
 * extension" in the header opens the install wizard.
 */
export default function AdminExtensionsPage() {
  return (
    <AdminGate>
      <AdminPlugins />
    </AdminGate>
  );
}

function AdminPlugins() {
  const t = useTranslations("admin.extensions");
  const parent = useAdminParent();
  const router = useRouter();
  const { state, reload } = useLoad(listAdminExtensions, []);
  const [status, setStatus] = useState<ExtensionStatus | "">("");
  const [source, setSource] = useState<ExtensionSource | "">("");
  const all = state.kind === "ready" ? state.data.extensions : [];
  const rows = all.filter(
    (p) => (status === "" || p.status === status) && (source === "" || p.source === source),
  );

  const columns: Column<AdminExtension>[] = [
    { key: "name", header: t("columns.name"), cell: (p) => p.name },
    { key: "version", header: t("columns.version"), tone: "muted", cell: (p) => p.version },
    { key: "source", header: t("columns.source"), cell: (p) => t(`source.${p.source}`) },
    {
      key: "status",
      header: t("columns.status"),
      cell: (p) => <ExtensionStatusMark status={p.status} />,
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
        actions: [{ label: t("install"), variant: "primary", href: "/admin/extensions/install" }],
      }}
      rail={
        <Stack gap={16}>
          <RadioGroup
            label={t("filters.status")}
            value={status}
            onChange={(v) => setStatus(v as ExtensionStatus | "")}
            options={[
              { value: "", label: t("filters.allStatuses") },
              ...EXTENSION_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
            ]}
          />
          <RadioGroup
            label={t("filters.source")}
            value={source}
            onChange={(v) => setSource(v as ExtensionSource | "")}
            options={[
              { value: "", label: t("filters.allSources") },
              ...EXTENSION_SOURCES.map((s) => ({ value: s, label: t(`source.${s}`) })),
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
          onOpen={(p) => router.push(`/admin/extensions/${encodeURIComponent(p.name)}`)}
          rowLabel={(p) => p.name}
        />
      </Stack>
    </ListPage>
  );
}
