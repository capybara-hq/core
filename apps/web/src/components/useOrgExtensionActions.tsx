"use client";

import { useToast } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ApiClientError, issueLines } from "../lib/api";
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
import type { ToggleProblem } from "./OrgExtensionSheet";
import { SwitchOffDialog } from "./PluginSwitch";

type Busy = "toggle" | "sync";

/** One org extension and what its page decided about it. */
export interface OrgExtensionRow {
  ext: OrgExtension;
  label: string;
  /** Platform-wide (`all` / builtin): on in every org, the switch is the platform's. */
  platform: boolean;
  /**
   * The switch cannot be used (platform, unavailable or not switchable). Needing config never
   * locks it: an extension is switched on first and configured after, as on the Plugins page (it
   * gets no org-bound call until its effective config is valid, the kernel's `needsConfig`).
   */
  locked: boolean;
  unavailable: boolean;
  /** The deployment form is shown (an admin, an available extension with overridable fields). */
  overrides: boolean;
  /** Needs config: the kernel's `needsConfig` (effective config invalid or a required field missing). */
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
 * Extensions page, Model services on `/settings/models`): each extension's row state (unavailable
 * with the kernel's reason, a refused switch, Needs config, on / platform / off), the switch (switching a plugin
 * off answers its switch-off preview first, shown in {@link OrgExtensionActions.switchOffDialog} and
 * confirmed with its hash; a stale preview is read again), the directory sync, and why a switch was refused (the Sheet opens for it via
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
  // Per extension: what is in flight and why a switch was refused.
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [problems, setProblems] = useState<Record<string, ToggleProblem>>({});
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
          ? // an org admin configures it (配置 on the row); everyone else waits for one
            { label: t(canEdit ? "needsConfig" : "needsAdmin"), tone: "warn" }
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
      locked: platform || ext.switchable === false || unavailable,
      unavailable,
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
   * Why a switch was refused, shown under the state in the extension's Sheet (opened for it).
   */
  function refused(row: OrgExtensionRow, e: unknown) {
    const plugin = row.ext.plugin;
    onOpen(plugin);
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
        // the Plugins page to request it
        catalog:
          e instanceof ApiClientError &&
          (e.code === "plugin.disabled" || e.code === "catalog.approval_required"),
      };
    setOne(setProblems, plugin, problem);
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
    overrides: row.overrides,
    needsConfig: row.needsConfig,
    problem: row.problem,
    busy: busy[row.ext.plugin],
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
