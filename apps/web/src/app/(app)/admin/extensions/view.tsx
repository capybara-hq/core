"use client";

import {
  Badge,
  CellTitle,
  type Column,
  DataTable,
  ListPage,
  Sheet,
  Stack,
  Subsection,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  AdminExtensionOverview,
  AdminExtensionPermissions,
  type ExtensionList,
  useAdminExtensionLive,
} from "../../../../components/AdminExtensionPanels";
import { ExtensionStatusMark } from "../../../../components/AdminExtensionParts";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { useDeploymentConfig } from "../../../../components/ExtensionDeploymentConfig";
import {
  useCapabilityLabel,
  useExtensionTab,
  useExtensionTabItems,
} from "../../../../components/ExtensionTabs";
import { NoAccess } from "../../../../components/NoAccess";
import { PermissionSummary } from "../../../../components/PermissionSummary";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AdminExtension,
  displaySource,
  replicaSummary,
} from "../../../../lib/admin-extensions";
import {
  capabilitiesIn,
  type ExtensionTab,
  inTab,
  matchesSearch,
  sortExtensions,
  tabCounts,
} from "../../../../lib/extension-capabilities";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import { adminExtensionsQuery, extensionChangeKeys } from "../../../../lib/query/admin";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/** An extension that is neither running nor deliberately off needs an admin. */
const needsAttention = (p: AdminExtension) => p.status !== "enabled" && p.status !== "disabled";

/** 0 needs attention, 1 enabled, 2 disabled. */
const rankOf = (p: AdminExtension): 0 | 1 | 2 =>
  needsAttention(p) ? 0 : p.status === "enabled" ? 1 : 2;

/**
 * `/admin/extensions`: every extension on the deployment (super admins), the same structure as the
 * workspace 扩展 page: a ListPage with one DataTable, the head's tabs by capability (全部, 模型,
 * 网页, 连接器, 沙箱, 存储, 工具与界面; `lib/extension-capabilities.ts`, `?tab=` keeps the open one)
 * with counts and a search by name. A warn callout above the tabs names the extensions that need
 * attention (anything neither enabled nor disabled, such as a required extension without config);
 * they sort first, then the enabled ones, then the disabled ones, by name. A row: the display name
 * over `name · version`, what it provides under that tab, the state (with the 「敏感」 mark), the
 * source (预装 / 配置 / 安装, required), who the plugin is offered to and how many orgs run it, the
 * replicas; its menu holds 升级 for an installed extension.
 *
 * A row opens a Sheet (its page, `/admin/extensions/[name]`, opens from the Sheet's head): one
 * status line on top (what config is missing), then divided regions: 部署配置 (the form; its save
 * in the Sheet's footer), 状态 (one facts block: state, capabilities, scope, source, version,
 * package; the lifecycle actions), 副本 (`AdminExtensionOverview`), and 权限, folded into one line
 * that opens the full review with the approval (open by itself while an approval waits). From the query cache
 * (the layout prefetched the list on a first load).
 */
export default function AdminExtensionsView({ tab }: { tab: ExtensionTab }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminExtensionsRead initialTab={tab} orgId={gate.me.currentOrgId} />;
}

function AdminExtensionsRead({
  initialTab,
  orgId,
}: {
  initialTab: ExtensionTab;
  orgId: string | null;
}) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.extensions");
  const te = useTranslations("extensions");
  const read = usePageQuery(adminExtensionsQuery());
  const [tab, setTab] = useExtensionTab(initialTab);
  const [search, setSearch] = useState("");
  const all = read.kind === "ready" ? read.data.extensions : null;
  const counts = all === null ? null : tabCounts(all, (p) => p.permissions);
  const header = {
    path: [...scope, { label: "extensions" }],
    title: t("title"),
    description: t("description"),
    tabs: useExtensionTabItems(counts, setTab),
    activeTab: tab,
    search: { label: te("search"), value: search, onChange: setSearch },
  };
  const columns = useColumns();
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading" || all === null)
    return (
      <ListPage
        header={header}
        loading={{
          table: {
            label: t("title"),
            columns: columns.map(({ key, header: h }) => ({ key, header: h, cell: () => null })),
            rowHeight: "roomy",
          },
        }}
      />
    );
  return (
    <AdminExtensions
      all={all}
      data={read.data}
      header={header}
      tab={tab}
      search={search}
      clearSearch={() => setSearch("")}
      orgId={orgId}
    />
  );
}

/** The table's columns (the loading shape draws the same headers). */
function useColumns(tab: ExtensionTab = "all"): Column<AdminExtension>[] {
  const t = useTranslations("admin.extensions");
  const tScope = useTranslations("catalog.scope");
  const lang = labelLocale(useLocale());
  const capabilityLabel = useCapabilityLabel();
  return [
    {
      key: "name",
      header: t("columns.name"),
      // wide enough for "connector-openapi · v0.1.0-rc.0"; the wrapping capabilities take the rest
      width: 280,
      cell: (p) => (
        <CellTitle
          title={extensionLabel(p, lang)}
          description={[p.displayName ? p.name : null, `v${p.version}`]
            .filter((x): x is string => x !== null)
            .join(" · ")}
          mono
        />
      ),
    },
    {
      key: "capabilities",
      header: t("columns.capabilities"),
      wrap: true,
      tone: "muted",
      cell: (p) => {
        const caps = capabilitiesIn(p.permissions, tab).map(capabilityLabel);
        return caps.length > 0 ? caps : "—";
      },
    },
    {
      key: "status",
      header: t("columns.status"),
      cell: (p) => (
        <Stack direction="row" gap={8} align="center">
          <ExtensionStatusMark status={p.status} />
          {p.sensitive && <Badge tone="warn">{t("sensitive")}</Badge>}
        </Stack>
      ),
    },
    {
      key: "source",
      header: t("columns.source"),
      tone: "muted",
      cell: (p) =>
        [
          p.builtin ? t("builtin") : t(`source.${displaySource(p)}`),
          p.required && !p.builtin ? t("required") : null,
        ]
          .filter((x): x is string => x !== null)
          .join(" · "),
    },
    {
      key: "scope",
      header: t("columns.scope"),
      tone: "muted",
      // "全部组织启用 · 12 个组织" whole
      width: 200,
      // Who the plugin is offered to, then how many orgs run it (— without a catalog item).
      cell: (p) =>
        p.scope
          ? [
              tScope(p.scope),
              p.enabledOrgs !== undefined ? t("meta.orgs", { n: p.enabledOrgs }) : null,
            ]
              .filter((x): x is string => x !== null)
              .join(" · ")
          : "—",
    },
    {
      key: "replicas",
      header: t("columns.replicas"),
      tone: "muted",
      cell: (p) => {
        const r = replicaSummary(p);
        return r.total > 0
          ? t(r.consistent ? "replicas.consistent" : "replicas.diverged", {
              ok: r.inSync,
              n: r.total,
            })
          : t("replicas.none");
      },
    },
  ];
}

function AdminExtensions({
  all,
  data,
  header,
  tab,
  search,
  clearSearch,
  orgId,
}: {
  all: AdminExtension[];
  data: ExtensionList;
  header: Parameters<typeof ListPage>[0]["header"];
  tab: ExtensionTab;
  search: string;
  clearSearch(): void;
  orgId: string | null;
}) {
  const t = useTranslations("admin.extensions");
  const te = useTranslations("extensions");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const [open, setOpen] = useState<string | null>(null);
  const columns = useColumns(tab);
  const sorted = sortExtensions(all, rankOf, (p) => extensionLabel(p, lang), locale);
  const rows = inTab(sorted, tab, (p) => p.permissions).filter((p) =>
    matchesSearch(search, extensionLabel(p, lang), p.name),
  );
  const attention = sorted.filter(needsAttention);
  const callout =
    attention.length > 0
      ? {
          tone: "warn" as const,
          children: t("callout", {
            n: attention.length,
            names: attention.map((p) => extensionLabel(p, lang)).join(", "),
          }),
          // One: open it; several sort first in the list.
          ...(attention.length === 1
            ? {
                action: {
                  label: t("calloutFix"),
                  onSelect: () => setOpen(attention[0]?.name ?? null),
                },
              }
            : {}),
        }
      : undefined;
  // Extensions arrive with plugins: the empty state points at the plugin import page.
  const empty =
    all.length === 0
      ? {
          text: t("empty"),
          action: {
            label: t("importPlugin"),
            variant: "primary" as const,
            href: "/admin/plugins/import",
          },
        }
      : undefined;
  const current = open === null ? undefined : all.find((p) => p.name === open);
  return (
    <ListPage header={header} {...(callout ? { callout } : {})} {...(empty ? { empty } : {})}>
      <DataTable<AdminExtension>
        label={t("title")}
        columns={columns}
        rows={rows}
        rowKey={(p) => p.name}
        rowLabel={(p) => extensionLabel(p, lang)}
        rowHeight="roomy"
        {...(open === null ? {} : { activeKey: open })}
        onOpen={(p) => setOpen(p.name)}
        // The row and the Sheet's head open the extension: the menu holds only 升级.
        rowMenu={(p) =>
          p.source === "install"
            ? [
                {
                  label: t("upgrade"),
                  // An upgrade is importing the newer plugin version.
                  href: "/admin/plugins/import",
                },
              ]
            : []
        }
        empty={{ title: te("emptyTab") }}
        {...(search.trim() !== ""
          ? {
              noResults: {
                description: te("noResults", { query: search.trim() }),
                onClear: clearSearch,
              },
            }
          : {})}
      />
      {current !== undefined && (
        <AdminExtensionSheet
          key={current.name}
          plugin={current}
          drainSeconds={data.drainSeconds}
          orgId={orgId}
          onClose={() => setOpen(null)}
        />
      )}
    </ListPage>
  );
}

/**
 * One deployment extension in a Sheet: the status line, then the regions 部署配置, 状态, 副本 and
 * 权限 (a region with nothing to show is left out); the config's save in the footer.
 */
function AdminExtensionSheet({
  plugin,
  drainSeconds,
  orgId,
  onClose,
}: {
  plugin: AdminExtension;
  drainSeconds: number;
  orgId: string | null;
  onClose(): void;
}) {
  const t = useTranslations("admin.extensions");
  const te = useTranslations("extensions");
  const tScope = useTranslations("catalog.scope");
  const lang = labelLocale(useLocale());
  const capabilityLabel = useCapabilityLabel();
  const qc = useQueryClient();
  const { moving, changed } = useAdminExtensionLive(plugin.name, orgId, plugin);
  const capabilities = capabilitiesIn(plugin.permissions, "all").map(capabilityLabel);
  // 待批准: the status says so, or the permissions grew past the approved snapshot.
  const approval = plugin.status === "pending_approval" || plugin.added.length > 0;
  // The extension's state (pending config) and the org's readiness may change with a save.
  const config = useDeploymentConfig({
    name: plugin.name,
    drainSeconds,
    pending: plugin.status === "pending_config",
    enabled: plugin.configurable,
    onChanged: () => {
      for (const queryKey of [adminExtensionsQuery().queryKey, ...extensionChangeKeys(orgId)])
        void qc.invalidateQueries({ queryKey });
    },
  });
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={extensionLabel(plugin, lang)}
      meta={[plugin.displayName ? plugin.name : null, `v${plugin.version}`]
        .filter((x): x is string => x !== null)
        .join(" · ")}
      width={720}
      openHref={`/admin/extensions/${encodeURIComponent(plugin.name)}`}
      dirty={config.dirty}
      {...(config.save !== null ? { footer: config.save } : {})}
    >
      {/* One status line, then the regions (spec §6.7): 部署配置, 状态, 副本, 权限 */}
      <Stack gap={16}>
        {config.notice}
        {config.form !== null && (
          <Subsection title={t("detail.sections.config")} variant="divided">
            {config.form}
          </Subsection>
        )}
        <AdminExtensionOverview
          plugin={plugin}
          drainSeconds={drainSeconds}
          moving={moving}
          onUninstalled={onClose}
          place="sheet"
          leadFacts={[
            { k: te("stateTitle"), v: <ExtensionStatusMark status={plugin.status} /> },
            {
              k: te("capabilitiesTitle"),
              v: capabilities.length > 0 ? capabilities.join(" · ") : "—",
            },
            ...(plugin.scope
              ? [
                  {
                    k: t("columns.scope"),
                    v: [
                      tScope(plugin.scope),
                      plugin.enabledOrgs !== undefined
                        ? t("meta.orgs", { n: plugin.enabledOrgs })
                        : null,
                    ]
                      .filter((x): x is string => x !== null)
                      .join(" · "),
                  },
                ]
              : []),
          ]}
          {...changed}
        />
        {plugin.permissions.length > 0 && (
          <Subsection title={t("detail.sections.permissions")} variant="divided">
            <PermissionSummary
              groups={plugin.permissions}
              sensitive={plugin.sensitive}
              defaultOpen={approval}
            >
              <AdminExtensionPermissions plugin={plugin} {...changed} />
            </PermissionSummary>
          </Subsection>
        )}
      </Stack>
    </Sheet>
  );
}
