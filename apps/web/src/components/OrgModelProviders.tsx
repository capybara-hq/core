"use client";

import {
  Button,
  Callout,
  FormSection,
  ItemList,
  type ItemListRow,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError, configIssues, issueLines } from "../lib/api";
import { capabilitiesIn } from "../lib/extension-capabilities";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import {
  capabilityGroups,
  type OrgExtension,
  type PutOrgExtensionInput,
  putOrgExtension,
} from "../lib/extensions";
import { orgExtensionChangeKeys } from "../lib/query/admin";
import { orgExtensionsQuery } from "../lib/query/channels";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { readinessQuery } from "../lib/query/shell";
import { useErrorMessage } from "../lib/use-error-message";
import { hasConfigFields } from "./config-form/model";
import { useCapabilityLabel } from "./ExtensionTabs";
import { OrgExtensionSheet, type SaveError, type ToggleProblem } from "./OrgExtensionSheet";

type Busy = "toggle" | "save" | "saveEnable";

/** What the page decided about one model service in the org. */
interface Provider {
  ext: OrgExtension;
  label: string;
  unavailable: boolean;
  /** On in every org (a required bootstrap plugin): the switch is the platform's. */
  platform: boolean;
  /** The org admin can turn it on or off here (the plugin's switch is the org's). */
  switchable: boolean;
  configForm: boolean;
  overrides: boolean;
  needsConfig: boolean;
  state: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
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

/** The org's extensions that provide models (the 模型 tab of the 扩展 page). */
export const modelProvidersOf = (extensions: readonly OrgExtension[]): OrgExtension[] =>
  extensions.filter((e) => capabilitiesIn(capabilityGroups(e), "model").length > 0);

/**
 * The org admin's one place to set up a model service (`/settings/models`, the setup checklist's
 * model step while the org has none on): every model service the platform offers this org as a
 * row (its icon, name, state) with 启用 while it is off and the org may switch it on, and 配置
 * where it has org config or overridable platform fields, which opens the extension's Sheet (the
 * one org config form, 保存并启用 while it is off). While the platform has providers but none is
 * on here (readiness `not_enabled`) a warn line above the section says to turn one on. Turning a
 * service on invalidates the org's readiness, models and purposes, so the setup frame, the
 * checklist and the catalog below follow. Switching a service off stays on the 扩展 page (it asks
 * with the switch-off preview first).
 */
export function OrgModelProviders({
  orgId,
  superAdmin,
  providers: exts,
  open,
  onOpen,
}: {
  orgId: string;
  /** The viewer is a super admin: an unavailable service's Sheet links to the admin console. */
  superAdmin: boolean;
  /** The org's model services ({@link modelProvidersOf}); at least one. */
  providers: OrgExtension[];
  /** The service whose Sheet is open. */
  open: string | null;
  onOpen(plugin: string | null): void;
}) {
  const t = useTranslations("models.org.providers");
  const te = useTranslations("extensions");
  const lang = labelLocale(useLocale());
  const capabilityLabel = useCapabilityLabel();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  const readinessQ = readinessQuery(orgId);
  const notEnabled = useQuery(readinessQ).data?.modelProvider === "not_enabled";
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [problems, setProblems] = useState<Record<string, ToggleProblem>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, SaveError>>({});
  const [rounds, setRounds] = useState<Record<string, number>>({});

  const setOne = <V,>(
    set: (f: (m: Record<string, V>) => Record<string, V>) => void,
    plugin: string,
    v: V | undefined,
  ) =>
    set((m) => {
      const { [plugin]: _, ...rest } = m;
      return v === undefined ? rest : { ...rest, [plugin]: v };
    });

  // The answer is the extension as it is now: it replaces that one in the cached list. Turning a
  // service on also changes the org's readiness, models, purposes and the plugins' view.
  const put = useAppMutation({
    fn: (v: { plugin: string; input: PutOrgExtensionInput }) =>
      putOrgExtension(orgId, v.plugin, v.input),
    invalidates: () => [
      ...orgExtensionChangeKeys(orgId),
      keys.org(orgId).catalog(),
      keys.org(orgId).catalogItemsAll(),
      keys.org(orgId).pluginInstalls(),
    ],
    onSuccess: (r) => {
      if (!("extension" in r)) return;
      const next = r.extension;
      qc.setQueryData<{ extensions: OrgExtension[] }>(orgExtensionsQuery(orgId).queryKey, (d) =>
        d === undefined
          ? d
          : { ...d, extensions: d.extensions.map((p) => (p.plugin === next.plugin ? next : p)) },
      );
    },
  });

  const rows: Provider[] = exts.map((ext) => {
    const label = extensionLabel({ name: ext.plugin, displayName: ext.displayName }, lang);
    const unavailable = ext.available === false;
    const platform = ext.required === true;
    const switchable = !unavailable && !platform && ext.switchable !== false;
    const configForm = !unavailable && ext.configurable && hasConfigFields(ext.orgConfigSchema);
    const overrides =
      !unavailable && ext.overrideState !== undefined && ext.overrideState !== "none";
    const needsConfig = !unavailable && ext.needsConfig === true;
    const problem = problems[ext.plugin];
    const state: Provider["state"] = unavailable
      ? {
          label:
            ext.reason === undefined
              ? te("unavailable")
              : te("unavailableWith", { reason: te(`reasons.${ext.reason}`) }),
          tone: "warn",
        }
      : problem !== undefined
        ? { label: te("enableFailed"), tone: "fail" }
        : needsConfig
          ? { label: te("needsConfig"), tone: "warn" }
          : ext.enabled
            ? { label: te("enabled"), tone: "ok" }
            : switchable
              ? { label: te("disabled"), tone: "muted" }
              : { label: t("notOffered"), tone: "muted" };
    return {
      ext,
      label,
      unavailable,
      platform,
      switchable,
      configForm,
      overrides,
      needsConfig,
      state,
    };
  });

  /**
   * Why turning a service on (or 保存并启用) was refused, shown in its Sheet (opened for it): a
   * refused config marks the form's fields, the rest shows under the state.
   */
  function refused(row: Provider, e: unknown) {
    const plugin = row.ext.plugin;
    onOpen(plugin);
    if (row.configForm && e instanceof ApiClientError && e.code === "extension.config_invalid") {
      configRefused(plugin, e);
      return;
    }
    const problem: ToggleProblem =
      e instanceof ApiClientError && e.code === "extension.dependency_missing"
        ? {
            kind: "dependency_missing",
            extensionPoints: strings(e.rawDetails, "extensionPoint"),
          }
        : {
            kind: "other",
            message: errorMessage(e),
            extra: issueLines(e),
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

  /** Turns the service on (with `config`: 保存并启用, one PUT the kernel validates first). */
  async function enable(row: Provider, config?: Record<string, unknown>) {
    const plugin = row.ext.plugin;
    setOne<Busy>(setBusy, plugin, config === undefined ? "toggle" : "saveEnable");
    setOne<ToggleProblem>(setProblems, plugin, undefined);
    setOne<SaveError>(setSaveErrors, plugin, undefined);
    try {
      await put.mutateAsync({
        plugin,
        input: { enabled: true, ...(config !== undefined ? { config } : {}) },
      });
      if (config !== undefined) setRounds((m) => ({ ...m, [plugin]: (m[plugin] ?? 0) + 1 }));
      toast.success(t("enabledToast", { plugin: row.label }));
    } catch (e) {
      refused(row, e);
    } finally {
      setOne<Busy>(setBusy, plugin, undefined);
    }
  }

  async function save(row: Provider, config: Record<string, unknown>) {
    const plugin = row.ext.plugin;
    setOne<Busy>(setBusy, plugin, "save");
    setOne<SaveError>(setSaveErrors, plugin, undefined);
    try {
      await put.mutateAsync({ plugin, input: { config } });
      setRounds((m) => ({ ...m, [plugin]: (m[plugin] ?? 0) + 1 }));
      toast.success(te("configSaved", { plugin: row.label }));
    } catch (e) {
      configRefused(plugin, e);
    } finally {
      setOne<Busy>(setBusy, plugin, undefined);
    }
  }

  const listRows: ItemListRow[] = rows.map((r) => {
    const canEnable = !r.ext.enabled && r.switchable && !r.needsConfig;
    const canConfigure = r.configForm || r.overrides;
    const pending = busy[r.ext.plugin] !== undefined;
    return {
      id: r.ext.plugin,
      mark: { text: r.label, image: r.ext.icon ?? null },
      title: r.label,
      meta: [r.ext.displayName ? r.ext.plugin : null, versionLabel(r.ext.version)]
        .filter((x): x is string => x !== null)
        .join(" · "),
      status: {
        label: r.state.label,
        ...(r.state.tone === "warn" || r.state.tone === "fail" ? { tone: "accent" as const } : {}),
      },
      ...(canEnable || canConfigure
        ? {
            actions: (
              <>
                {canConfigure && (
                  <Button
                    density="dense"
                    disabled={pending}
                    aria-label={t("configureLabel", { plugin: r.label })}
                    onClick={() => onOpen(r.ext.plugin)}
                  >
                    {t("configure")}
                  </Button>
                )}
                {canEnable && (
                  <Button
                    density="dense"
                    variant="secondary"
                    loading={busy[r.ext.plugin] === "toggle"}
                    disabled={pending}
                    aria-label={t("enableLabel", { plugin: r.label })}
                    onClick={() => void enable(r)}
                  >
                    {t("enable")}
                  </Button>
                )}
              </>
            ),
          }
        : {}),
    };
  });

  const current = open === null ? undefined : rows.find((r) => r.ext.plugin === open);
  return (
    <>
      {notEnabled && <Callout tone="warn">{t("notEnabled")}</Callout>}
      <FormSection id="providers" title={t("title")} description={t("description")} flush>
        <ItemList label={t("title")} inset="flush" rows={listRows} />
      </FormSection>
      {current !== undefined && (
        <OrgExtensionSheet
          key={current.ext.plugin}
          orgId={orgId}
          extension={current.ext}
          label={current.label}
          canEdit
          superAdmin={superAdmin}
          capabilities={capabilitiesIn(capabilityGroups(current.ext), "all").map(capabilityLabel)}
          state={current.state}
          platform={current.platform}
          unavailable={current.unavailable}
          configForm={current.configForm}
          overrides={current.overrides}
          needsConfig={current.needsConfig}
          locked={!current.switchable}
          problem={problems[current.ext.plugin]}
          saveError={saveErrors[current.ext.plugin]}
          round={rounds[current.ext.plugin] ?? 0}
          busy={busy[current.ext.plugin]}
          onClose={() => onOpen(null)}
          onSave={(config) => void save(current, config)}
          onSaveAndEnable={(config) => void enable(current, config)}
          // Only switching off is refused for dependents, and this page never switches off
          onForceDisable={() => {}}
          // A model service is never a directory: the Sheet shows no 立即同步
          onSync={() => {}}
        />
      )}
    </>
  );
}
