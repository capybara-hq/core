"use client";

import {
  CellTitle,
  type Column,
  DataTable,
  initialOf,
  ListPage,
  Stack,
  Switch,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ApplyAppearanceAction } from "../../../components/ApplyAppearance";
import { hasConfigFields } from "../../../components/config-form/model";
import { savedConfigComplete } from "../../../components/config-form/org";
import { ErrorFrame } from "../../../components/ErrorFrame";
import {
  useCapabilityLabel,
  useExtensionTab,
  useExtensionTabItems,
} from "../../../components/ExtensionTabs";
import { FilePreviewersSection } from "../../../components/FilePreviewersSection";
import { NoAccess } from "../../../components/NoAccess";
import {
  OrgExtensionSheet,
  type SaveError,
  type ToggleProblem,
} from "../../../components/OrgExtensionSheet";
import { SwitchOffDialog } from "../../../components/PluginSwitch";
import { PointDefaultsSection } from "../../../components/PointDefaultsSection";
import { usePagePath } from "../../../components/shell/path";
import { UiArrangementSection } from "../../../components/UiArrangementSection";
import { ApiClientError, configIssues, issueLines } from "../../../lib/api";
import type { SwitchPreview } from "../../../lib/catalog";
import {
  capabilitiesIn,
  type ExtensionTab,
  inTab,
  matchesSearch,
  sortExtensions,
  tabCounts,
} from "../../../lib/extension-capabilities";
import { extensionLabel, labelLocale } from "../../../lib/extension-label";
import {
  capabilityGroups,
  type OrgExtension,
  type PutOrgExtensionInput,
  putOrgExtension,
  syncDirectory,
} from "../../../lib/extensions";
import { roleAtLeast } from "../../../lib/members";
import { orgExtensionChangeKeys } from "../../../lib/query/admin";
import { orgExtensionsQuery } from "../../../lib/query/channels";
import { keys } from "../../../lib/query/keys";
import { useAppMutation } from "../../../lib/query/mutation";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/extensions`: the org's 扩展 page, an object list by capability (a ListPage with one DataTable).
 * The head's tabs (全部, 模型, 网页, 连接器, 沙箱, 存储, 工具与界面; `lib/extension-capabilities.ts`
 * maps the extension points to them, `?tab=` keeps the open one) carry counts, with a search by
 * name. A row: the display name over `plugin · version`, what it can do under that tab, its state
 * (已启用 / 未启用 / 已启用 · 平台统一 / 待配置 / 不可用 with the kernel's reason, e.g. 不可用 · 缺少部署配置,
 * or a failed switch) and, for org admins,
 * the enable switch, which is its plugin's switch (spec §5 rule 7): switching it off answers the
 * plugin's switch-off preview first (what it takes away, the agents that use it), confirmed in a
 * dialog with the preview's hash. Rows needing attention (待配置, a refused switch) come first,
 * then those on, then the rest, by name. An extension that is off and whose saved org config lacks
 * a required field cannot be switched on (待配置: the switch is read-only, the Sheet says why and
 * its 保存并启用 saves the config and enables it in one PUT). An `all` or builtin plugin's
 * extension is on in every org (read-only switch); one the deployment cannot run now is 不可用.
 *
 * A row opens a Sheet: the org config form on top (保存配置 / 保存并启用), the state line (with why a
 * switch was refused: a missing dependency, dependents that remain, which can be force-disabled, or
 * the kernel's reason; a refused switch opens the Sheet by itself), 立即同步 for directory-sync
 * extensions, 应用此插件的外观 for a plugin on in the org that suggests an appearance (client
 * extensions spec §6.5: a dry run listed in a confirm dialog, then applied), and the permissions
 * folded into one line that opens the full blocks. Members read the
 * same list without the switch, and a Sheet with the capabilities and the state only (the kernel
 * gives them no config, secrets or permissions, P2-13, only the points each provides: their tabs
 * and chips come from those).
 *
 * Under the list, for org admins: the org's default providers of the points several extensions
 * provide (web tools spec §6; in 全部 and 网页) and the org's file previewers (`file-preview@1`; in
 * 全部 and 工具与界面). From the query cache (the layout prefetched all three on a first load); a
 * change writes the answer into the cached extensions, and enabling or disabling one also
 * invalidates what an extension brings (its UI, its pages, its file previewers, the default
 * providers' candidates) and the plugin's view.
 */
export default function ExtensionsView({ tab }: { tab: ExtensionTab }) {
  const ws = useWorkspace({ min: "member", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <Extensions
      orgId={ws.orgId}
      canEdit={roleAtLeast(ws.role, "admin")}
      superAdmin={ws.me.account.isSuperAdmin}
      initialTab={tab}
    />
  );
}

type Busy = "toggle" | "save" | "saveEnable" | "sync";

/** One row: the extension and what the page decided about it. */
interface Row {
  ext: OrgExtension;
  label: string;
  /** Platform-wide (`all` / builtin): on in every org, the switch is the platform's. */
  platform: boolean;
  /** The switch cannot be used (platform, unavailable, not switchable or waiting for config). */
  locked: boolean;
  unavailable: boolean;
  /** The org config form is shown (an admin, an available extension with fields). */
  configForm: boolean;
  /** The two-level deployment form is shown (an admin, an available extension with overridable fields). */
  overrides: boolean;
  /** 待配置: the kernel's `needsConfig` (effective config invalid or a required field missing). */
  needsConfig: boolean;
  problem: ToggleProblem | undefined;
  state: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
  /** 0 needs attention, 1 on, 2 off or unavailable. */
  rank: 0 | 1 | 2;
}

const strings = (raw: unknown[], key: string): string[] => [
  ...new Set(
    raw.flatMap((d) =>
      typeof d === "object" && d !== null && typeof (d as Record<string, unknown>)[key] === "string"
        ? [(d as Record<string, string>)[key] as string]
        : [],
    ),
  ),
];

function Extensions({
  orgId,
  canEdit,
  superAdmin,
  initialTab,
}: {
  orgId: string;
  canEdit: boolean;
  superAdmin: boolean;
  initialTab: ExtensionTab;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("extensions");
  const read = usePageQuery(orgExtensionsQuery(orgId));
  const [tab, setTab] = useExtensionTab(initialTab);
  const [search, setSearch] = useState("");
  const extensions = read.kind === "ready" ? read.data.extensions : null;
  const counts = extensions === null ? null : tabCounts(extensions, (e) => capabilityGroups(e));
  const tabItems = useExtensionTabItems(counts, setTab);
  const header = {
    path: [...scope, { label: "extensions" }],
    title: t("title"),
    description: t("description"),
    tabs: tabItems,
    activeTab: tab,
    search: { label: t("search"), value: search, onChange: setSearch },
  };
  const columns = useColumnHeaders(canEdit);
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading" || extensions === null)
    return (
      <ListPage
        header={header}
        loading={{ table: { label: t("title"), columns, rowHeight: "roomy" } }}
      />
    );
  return (
    <ExtensionList
      orgId={orgId}
      canEdit={canEdit}
      superAdmin={superAdmin}
      extensions={extensions}
      header={header}
      tab={tab}
      search={search}
      clearSearch={() => setSearch("")}
    />
  );
}

/** The table's column headers (the loading shape draws the same ones). */
function useColumnHeaders(canEdit: boolean): Column<never>[] {
  const t = useTranslations("extensions.columns");
  return [
    { key: "name", header: t("name"), width: 280, cell: () => null },
    { key: "capabilities", header: t("capabilities"), cell: () => null },
    { key: "state", header: t("state"), cell: () => null },
    ...(canEdit ? [{ key: "switch", header: t("switch"), cell: () => null }] : []),
  ];
}

function ExtensionList({
  orgId,
  canEdit,
  superAdmin,
  extensions,
  header,
  tab,
  search,
  clearSearch,
}: {
  orgId: string;
  canEdit: boolean;
  /** The viewer is the super admin: an unavailable extension links to the admin console. */
  superAdmin: boolean;
  extensions: OrgExtension[];
  header: Parameters<typeof ListPage>[0]["header"];
  tab: ExtensionTab;
  search: string;
  clearSearch(): void;
}) {
  const t = useTranslations("extensions");
  const tc = useTranslations("extensions.columns");
  const tp = useTranslations("plugins");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const capabilityLabel = useCapabilityLabel();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  // Per extension: what is in flight, why a switch was refused, a refused config, and the form's
  // round (bumped after a save: the form starts again from the saved config).
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [problems, setProblems] = useState<Record<string, ToggleProblem>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, SaveError>>({});
  const [rounds, setRounds] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  // Switching an extension's plugin off answers its switch-off preview first: shown in a dialog,
  // then confirmed with the preview's hash.
  const [off, setOff] = useState<{
    plugin: string;
    label: string;
    input: PutOrgExtensionInput;
    preview: SwitchPreview;
  } | null>(null);
  const [offNotice, setOffNotice] = useState<string>();

  const setOne = <V,>(
    set: (f: (m: Record<string, V>) => Record<string, V>) => void,
    plugin: string,
    v: V | undefined,
  ) =>
    set((m) => {
      const { [plugin]: _, ...rest } = m;
      return v === undefined ? rest : { ...rest, [plugin]: v };
    });

  // The answer is the extension as it is now: it replaces that one in the cached list.
  const onSaved = (next: OrgExtension) =>
    qc.setQueryData<{ extensions: OrgExtension[] }>(orgExtensionsQuery(orgId).queryKey, (d) =>
      d === undefined
        ? d
        : { ...d, extensions: d.extensions.map((p) => (p.plugin === next.plugin ? next : p)) },
    );
  // Enabling, disabling or configuring also changes what the extension brings to the org (its
  // readiness, UI, models and purposes); the list itself takes the answer.
  const put = useAppMutation({
    fn: (v: { plugin: string; input: PutOrgExtensionInput }) =>
      putOrgExtension(orgId, v.plugin, v.input),
    // (a plugin switch also changes the catalog's view and the installed plugins)
    invalidates: () => [
      ...orgExtensionChangeKeys(orgId),
      keys.org(orgId).catalog(),
      keys.org(orgId).catalogItemsAll(),
      keys.org(orgId).pluginInstalls(),
    ],
    onSuccess: (r) => {
      if ("extension" in r) onSaved(r.extension);
    },
  });
  const startSync = useAppMutation({
    fn: (plugin: string) => syncDirectory(orgId, plugin),
    invalidates: () => [],
  });

  const rows: Row[] = extensions.map((ext) => {
    const label = extensionLabel({ name: ext.plugin, displayName: ext.displayName }, lang);
    const unavailable = ext.available === false;
    const platform = ext.required === true;
    const configForm =
      canEdit && !unavailable && ext.configurable && hasConfigFields(ext.orgConfigSchema);
    const overrides =
      canEdit && !unavailable && ext.overrideState !== undefined && ext.overrideState !== "none";
    // The kernel decides (spec A §6); an older kernel leaves it out: derived from the saved org config
    const needsConfig =
      !unavailable &&
      (ext.needsConfig ??
        (!ext.enabled &&
          configForm &&
          !savedConfigComplete(ext.orgConfigSchema, ext.config, ext.secrets, lang)));
    const problem = problems[ext.plugin];
    const state: Row["state"] = unavailable
      ? {
          label:
            ext.reason === undefined
              ? t("unavailable")
              : t("unavailableWith", { reason: t(`reasons.${ext.reason}`) }),
          tone: "warn",
        }
      : problem !== undefined
        ? { label: t(ext.enabled ? "disableFailed" : "enableFailed"), tone: "fail" }
        : needsConfig
          ? { label: t("needsConfig"), tone: "warn" }
          : ext.enabled
            ? {
                label: platform
                  ? tp("state.platform")
                  : ext.catalogItem?.scope === "all"
                    ? tp("state.platformDefault")
                    : t("enabled"),
                tone: "ok",
              }
            : { label: t("disabled"), tone: "muted" };
    const rank: Row["rank"] =
      !unavailable && (problem !== undefined || needsConfig)
        ? 0
        : !unavailable && ext.enabled
          ? 1
          : 2;
    return {
      ext,
      label,
      platform,
      locked: platform || ext.switchable === false || unavailable || (needsConfig && !ext.enabled),
      unavailable,
      configForm,
      overrides,
      needsConfig,
      problem,
      state,
      rank,
    };
  });
  const sorted = sortExtensions(
    rows,
    (r) => r.rank,
    (r) => r.label,
    locale,
  );
  const shown = inTab(sorted, tab, (r) => capabilityGroups(r.ext)).filter((r) =>
    matchesSearch(search, r.label, r.ext.plugin),
  );
  const current = open === null ? undefined : rows.find((r) => r.ext.plugin === open);

  async function toggle(
    row: Row,
    enabled: boolean,
    force = false,
    confirm?: string,
    keepNotice = false,
  ) {
    const plugin = row.ext.plugin;
    setOne(setBusy, plugin, "toggle" as Busy);
    setOne<ToggleProblem>(setProblems, plugin, undefined);
    const input: PutOrgExtensionInput = {
      enabled,
      ...(force ? { force } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
    };
    try {
      const r = await put.mutateAsync({ plugin, input });
      if ("preview" in r) {
        setOff({
          plugin,
          label: row.label,
          input: { enabled, ...(force ? { force } : {}) },
          preview: r,
        });
        if (!keepNotice) setOffNotice(undefined);
        return;
      }
      setOff(null);
      setOffNotice(undefined);
      toast.success(t(enabled ? "enabledToast" : "disabledToast", { plugin: row.label }));
    } catch (e) {
      // The preview moved on before the confirm: read it again and show it
      if (
        confirm !== undefined &&
        e instanceof ApiClientError &&
        e.code === "plugin.switch_stale"
      ) {
        setOffNotice(tp("switchOff.stale"));
        await toggle(row, enabled, force, undefined, true);
        return;
      }
      setOff(null);
      refused(row, e);
    } finally {
      setOne<Busy>(setBusy, plugin, undefined);
    }
  }

  /**
   * Why a switch (or 保存并启用) was refused, shown in the extension's Sheet (opened for it): a
   * refused config marks the form's fields (as when saving), the rest shows under the state.
   */
  function refused(row: Row, e: unknown) {
    const plugin = row.ext.plugin;
    setOpen(plugin);
    if (row.configForm && e instanceof ApiClientError && e.code === "extension.config_invalid") {
      configRefused(plugin, e);
      return;
    }
    let problem: ToggleProblem;
    if (e instanceof ApiClientError && e.code === "extension.dependency_missing")
      problem = {
        kind: "dependency_missing",
        extensionPoints: strings(e.rawDetails, "extensionPoint"),
      };
    else if (e instanceof ApiClientError && e.code === "extension.has_dependents")
      problem = { kind: "has_dependents", extensions: strings(e.rawDetails, "plugin") };
    else
      problem = {
        kind: "other",
        message: errorMessage(e),
        extra: issueLines(e),
        // Refused by its plugin (stopped by the platform, not offered to this org): link to
        // the 插件 page to request it
        catalog:
          e instanceof ApiClientError &&
          (e.code === "plugin.disabled" || e.code === "catalog.approval_required"),
      };
    setOne(setProblems, plugin, problem);
  }

  function configRefused(plugin: string, e: unknown) {
    const issues = configIssues(e);
    setOne<SaveError>(setSaveErrors, plugin, {
      message: errorMessage(e),
      extra: issues.length > 0 ? [] : issueLines(e),
      issues,
    });
  }

  async function save(row: Row, config: Record<string, unknown>) {
    const plugin = row.ext.plugin;
    setOne(setBusy, plugin, "save" as Busy);
    setOne<SaveError>(setSaveErrors, plugin, undefined);
    try {
      await put.mutateAsync({ plugin, input: { config } });
      setRounds((m) => ({ ...m, [plugin]: (m[plugin] ?? 0) + 1 }));
      toast.success(t("configSaved", { plugin: row.label }));
    } catch (e) {
      configRefused(plugin, e);
    } finally {
      setOne<Busy>(setBusy, plugin, undefined);
    }
  }

  /** 保存并启用: the config and the switch in one PUT (the kernel validates before installing). */
  async function saveAndEnable(row: Row, config: Record<string, unknown>) {
    const plugin = row.ext.plugin;
    setOne(setBusy, plugin, "saveEnable" as Busy);
    setOne<SaveError>(setSaveErrors, plugin, undefined);
    setOne<ToggleProblem>(setProblems, plugin, undefined);
    try {
      await put.mutateAsync({ plugin, input: { enabled: true, config } });
      setRounds((m) => ({ ...m, [plugin]: (m[plugin] ?? 0) + 1 }));
      toast.success(t("enabledToast", { plugin: row.label }));
    } catch (e) {
      refused(row, e);
    } finally {
      setOne<Busy>(setBusy, plugin, undefined);
    }
  }

  async function sync(row: Row) {
    const plugin = row.ext.plugin;
    setOne(setBusy, plugin, "sync" as Busy);
    try {
      await startSync.mutateAsync(plugin);
      toast.success(t("syncStarted"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOne<Busy>(setBusy, plugin, undefined);
    }
  }

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: tc("name"),
      // wide enough for "connector-openapi · v0.1.0-rc.0"; the wrapping capabilities take the rest
      width: 280,
      cell: (r) => (
        <CellTitle
          title={r.label}
          // the plugin's icon, the initial without one (spec §6.17)
          initial={initialOf(r.label)}
          image={r.ext.icon ?? null}
          description={[r.ext.displayName ? r.ext.plugin : null, versionLabel(r.ext.version)]
            .filter((x): x is string => x !== null)
            .join(" · ")}
          mono
        />
      ),
    },
    {
      key: "capabilities",
      header: tc("capabilities"),
      wrap: true,
      tone: "muted",
      cell: (r) => {
        const caps = capabilitiesIn(capabilityGroups(r.ext), tab).map(capabilityLabel);
        return caps.length > 0 ? caps : "—";
      },
    },
    {
      key: "state",
      header: tc("state"),
      // "已启用 · 平台默认" whole; the wrapping capabilities give way
      fit: true,
      cell: (r) => <Text tone={r.state.tone}>{r.state.label}</Text>,
    },
    ...(canEdit
      ? [
          {
            key: "switch",
            header: tc("switch"),
            interactive: true,
            fit: true,
            cell: (r: Row) => (
              <Switch
                label={t("enableLabel", { plugin: r.label })}
                checked={r.ext.enabled}
                disabled={busy[r.ext.plugin] !== undefined || r.locked}
                onChange={(on) => void toggle(r, on)}
              />
            ),
          } satisfies Column<Row>,
        ]
      : []),
  ];

  const section = (id: "defaults" | "previewers") =>
    canEdit &&
    (tab === "all" || (id === "defaults" ? tab === "web" : tab === "tools")) &&
    search.trim() === "";
  // 界面位置: members read it too (read only)
  const arrangement = (tab === "all" || tab === "tools") && search.trim() === "";

  return (
    <ListPage header={header}>
      <Stack gap={24}>
        <DataTable<Row>
          label={t("title")}
          columns={columns}
          rows={shown}
          rowKey={(r) => r.ext.plugin}
          rowLabel={(r) => r.label}
          rowHeight="roomy"
          {...(open === null ? {} : { activeKey: open })}
          onOpen={(r) => setOpen(r.ext.plugin)}
          empty={{ title: extensions.length === 0 ? t("empty") : t("emptyTab") }}
          {...(search.trim() !== "" && extensions.length > 0
            ? {
                noResults: {
                  description: t("noResults", { query: search.trim() }),
                  onClear: clearSearch,
                },
              }
            : {})}
        />
        {section("defaults") && <PointDefaultsSection orgId={orgId} />}
        {section("previewers") && <FilePreviewersSection orgId={orgId} />}
        {arrangement && <UiArrangementSection scope={{ kind: "org", orgId }} canEdit={canEdit} />}
      </Stack>
      {current !== undefined && (
        <OrgExtensionSheet
          key={current.ext.plugin}
          orgId={orgId}
          extension={current.ext}
          label={current.label}
          canEdit={canEdit}
          superAdmin={superAdmin}
          capabilities={capabilitiesIn(capabilityGroups(current.ext), "all").map(capabilityLabel)}
          state={current.state}
          platform={current.platform}
          unavailable={current.unavailable}
          configForm={current.configForm}
          overrides={current.overrides}
          needsConfig={current.needsConfig}
          locked={current.platform || current.ext.switchable === false || current.unavailable}
          problem={current.problem}
          saveError={saveErrors[current.ext.plugin]}
          round={rounds[current.ext.plugin] ?? 0}
          busy={busy[current.ext.plugin]}
          onClose={() => setOpen(null)}
          onSave={(config) => void save(current, config)}
          onSaveAndEnable={(config) => void saveAndEnable(current, config)}
          onForceDisable={() => void toggle(current, false, true)}
          onSync={() => void sync(current)}
          {...(canEdit &&
            current.ext.enabled &&
            !current.unavailable &&
            current.ext.suggestedAppearance != null && {
              appearance: (
                <ApplyAppearanceAction
                  level={{ kind: "org", orgId, extension: current.ext.plugin }}
                  name={current.label}
                  clientCode={current.ext.client != null}
                />
              ),
            })}
        />
      )}
      {off !== null && (
        <SwitchOffDialog
          orgId={orgId}
          name={off.label}
          preview={off.preview.preview}
          busy={busy[off.plugin] === "toggle"}
          notice={offNotice}
          onConfirm={() => {
            const row = rows.find((r) => r.ext.plugin === off.plugin);
            if (row !== undefined)
              void toggle(row, false, off.input.force === true, off.preview.confirm);
          }}
          onCancel={() => {
            setOff(null);
            setOffNotice(undefined);
          }}
        />
      )}
    </ListPage>
  );
}
