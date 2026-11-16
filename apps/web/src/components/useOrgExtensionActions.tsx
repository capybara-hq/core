"use client";

import { useToast } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ApiClientError, configIssues, issueLines } from "../lib/api";
import type { SwitchPreview } from "../lib/catalog";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import {
  type OrgExtension,
  type PutOrgExtensionInput,
  putOrgExtension,
  syncDirectory,
} from "../lib/extensions";
import { orgExtensionChangeKeys } from "../lib/query/admin";
import { orgExtensionsQuery } from "../lib/query/channels";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { hasConfigFields } from "./config-form/model";
import type { SaveError, ToggleProblem } from "./OrgExtensionSheet";
import { SwitchOffDialog } from "./PluginSwitch";

type Busy = "toggle" | "save" | "saveEnable" | "sync";

/** One org extension and what its page decided about it. */
export interface OrgExtensionRow {
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

/**
 * What an org admin does with the org's extensions, shared by every page that lists them (the
 * 扩展 page, 模型服务 on `/settings/models`): each extension's row state (unavailable with the
 * kernel's reason, a refused switch, 待配置, on / platform / off), the switch (switching a plugin
 * off answers its switch-off preview first, shown in {@link OrgExtensionActions.switchOffDialog} and
 * confirmed with its hash; a stale preview is read again), saving the org config, 保存并启用 (one
 * PUT), the directory sync, and why a switch or a config was refused (the Sheet opens for it via
 * `onOpen`). A change also invalidates what an extension brings to the org (its readiness, UI,
 * models, purposes, the catalog's view); the cached list takes the answered extension.
 */
export function useOrgExtensionActions({
  orgId,
  canEdit,
  extensions,
  onOpen,
}: {
  orgId: string;
  canEdit: boolean;
  extensions: readonly OrgExtension[];
  /** Opens the extension's Sheet (a refusal is shown there). */
  onOpen(plugin: string): void;
}) {
  const t = useTranslations("extensions");
  const tp = useTranslations("plugins");
  const lang = labelLocale(useLocale());
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  // Per extension: what is in flight, why a switch was refused, a refused config, and the form's
  // round (bumped after a save: the form starts again from the saved config).
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [problems, setProblems] = useState<Record<string, ToggleProblem>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, SaveError>>({});
  const [rounds, setRounds] = useState<Record<string, number>>({});
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

  const rows: OrgExtensionRow[] = extensions.map((ext) => {
    const label = extensionLabel({ name: ext.plugin, displayName: ext.displayName }, lang);
    const unavailable = ext.available === false;
    const platform = ext.required === true;
    const configForm =
      canEdit && !unavailable && ext.configurable && hasConfigFields(ext.orgConfigSchema);
    const overrides =
      canEdit && !unavailable && ext.overrideState !== undefined && ext.overrideState !== "none";
    // The kernel decides (spec A §6)
    const needsConfig = !unavailable && ext.needsConfig;
    const problem = problems[ext.plugin];
    const state: OrgExtensionRow["state"] = unavailable
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
    const rank: OrgExtensionRow["rank"] =
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

  async function toggle(
    row: OrgExtensionRow,
    enabled: boolean,
    force = false,
    confirm?: string,
    keepNotice = false,
  ) {
    const plugin = row.ext.plugin;
    setOne<Busy>(setBusy, plugin, "toggle");
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
  function refused(row: OrgExtensionRow, e: unknown) {
    const plugin = row.ext.plugin;
    onOpen(plugin);
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

  async function save(row: OrgExtensionRow, config: Record<string, unknown>) {
    const plugin = row.ext.plugin;
    setOne<Busy>(setBusy, plugin, "save");
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
  async function saveAndEnable(row: OrgExtensionRow, config: Record<string, unknown>) {
    const plugin = row.ext.plugin;
    setOne<Busy>(setBusy, plugin, "saveEnable");
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

  async function sync(row: OrgExtensionRow) {
    const plugin = row.ext.plugin;
    setOne<Busy>(setBusy, plugin, "sync");
    try {
      await startSync.mutateAsync(plugin);
      toast.success(t("syncStarted"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOne<Busy>(setBusy, plugin, undefined);
    }
  }

  /** The `OrgExtensionSheet` props the actions decide for `row` (the page adds the rest). */
  const sheetProps = (row: OrgExtensionRow) => ({
    extension: row.ext,
    label: row.label,
    state: row.state,
    platform: row.platform,
    unavailable: row.unavailable,
    configForm: row.configForm,
    overrides: row.overrides,
    needsConfig: row.needsConfig,
    // The Sheet's 保存并启用 waits for no config: only the switch's owner and availability lock it
    locked: row.platform || row.ext.switchable === false || row.unavailable,
    problem: row.problem,
    saveError: saveErrors[row.ext.plugin],
    round: rounds[row.ext.plugin] ?? 0,
    busy: busy[row.ext.plugin],
    onSave: (config: Record<string, unknown>) => void save(row, config),
    onSaveAndEnable: (config: Record<string, unknown>) => void saveAndEnable(row, config),
    onForceDisable: () => void toggle(row, false, true),
    onSync: () => void sync(row),
  });

  const switchOffDialog: ReactNode =
    off === null ? null : (
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
    );

  return {
    rows,
    /** What is in flight per extension. */
    busy,
    toggle: (row: OrgExtensionRow, enabled: boolean) => toggle(row, enabled),
    sheetProps,
    switchOffDialog,
  };
}

export type OrgExtensionActions = ReturnType<typeof useOrgExtensionActions>;
