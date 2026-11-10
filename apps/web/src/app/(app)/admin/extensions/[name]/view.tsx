"use client";

import {
  type Column,
  DataTable,
  DetailPage,
  ObjectMark,
  Stack,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { AdminClientCode } from "../../../../../components/AdminClientCode";
import {
  AdminExtensionOverview,
  AdminExtensionPermissions,
  type ExtensionList,
  useAdminExtensionLive,
} from "../../../../../components/AdminExtensionPanels";
import { ExtensionStatusMark } from "../../../../../components/AdminExtensionParts";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { ExtensionDeploymentConfig } from "../../../../../components/ExtensionDeploymentConfig";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import type { AdminExtension } from "../../../../../lib/admin-extensions";
import { extensionLabel, labelLocale } from "../../../../../lib/extension-label";
import {
  adminExtensionQuery,
  adminExtensionsQuery,
  extensionChangeKeys,
} from "../../../../../lib/query/admin";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useAdmin } from "../../../../../lib/query/workspace";
import NotFound from "../../../not-found";

const TABS = ["overview", "permissions", "config"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/extensions/[name]`: an extension (super admins, DetailPage).
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
 * 界面代码 (an extension with client code): its build, files, sizes and error reports, and
 * 停用界面代码 (client extensions spec §10.2, §10.4).
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
          // the plugin's mark keeps its place
          loading: { title: true, avatar: true },
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
  const { moving, changed } = useAdminExtensionLive(name, orgId, plugin);
  const listKey = adminExtensionsQuery().queryKey;

  return (
    <DetailPage
      header={{
        path: [...scope, { label: "extensions", href: "/admin/extensions" }, { label }],
        title: label,
        ...(plugin && {
          // the plugin's icon, the initial without one (spec §6.17)
          avatar: <ObjectMark text={label} image={plugin.icon ?? null} size={40} />,
          count: versionLabel(plugin.version),
          status: (
            <ExtensionStatusMark
              status={plugin.status}
              orgsNeedingConfig={plugin.orgsNeedingConfig}
            />
          ),
        }),
      }}
      tabs={tabs(tab, setTab, plugin?.status === "pending_approval")}
    >
      {plugin === undefined ? (
        <Text tone="muted">{t("detail.notFound")}</Text>
      ) : tab === "overview" ? (
        <Stack gap={16}>
          <AdminExtensionOverview
            plugin={plugin}
            drainSeconds={data.drainSeconds}
            moving={moving}
            {...changed}
          />
          <UiDropped dropped={plugin.uiDropped} />
          <AdminClientCode plugin={plugin} />
        </Stack>
      ) : tab === "permissions" ? (
        <AdminExtensionPermissions plugin={plugin} {...changed} />
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

/**
 * 未生效的界面 (UI slots spec §3.2): the interfaces the loaded extension declared that the platform
 * left out, each with its reason. Drawn only when there are some.
 */
function UiDropped({ dropped }: { dropped: AdminExtension["uiDropped"] | undefined }) {
  const t = useTranslations("admin.extensions.uiDropped");
  if (dropped === undefined || dropped.length === 0) return null;
  const columns: Column<AdminExtension["uiDropped"][number]>[] = [
    { key: "id", header: t("columns.id"), fit: true, cell: (d) => d.id },
    { key: "slot", header: t("columns.slot"), tone: "muted", fit: true, cell: (d) => d.ref },
    {
      key: "reason",
      header: t("columns.reason"),
      tone: "muted",
      wrap: true,
      cell: (d) => (d.reason === "unknown-slot" ? t("unknownSlot") : t("unsupportedVersion")),
    },
  ];
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("title")}
      </Text>
      <Text variant="prose">{t("description")}</Text>
      <DataTable
        label={t("title")}
        columns={columns}
        rows={dropped}
        rowKey={(d) => `${d.id}/${d.ref}`}
      />
    </Stack>
  );
}
