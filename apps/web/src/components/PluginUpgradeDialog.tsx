"use client";

import {
  Button,
  Card,
  Dialog,
  Skeleton,
  Stack,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  type ConnectorInstallInput,
  displayNameOf,
  type OrgCatalogTemplate,
  type PluginUpgradeBody,
  type UpgradePreview,
  upgradePlugin,
} from "../lib/catalog";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import type { OrgExtension } from "../lib/extensions";
import { pluginChangeKeys, pluginUpgradePreviewQuery } from "../lib/query/catalog";
import { orgExtensionsQuery } from "../lib/query/channels";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import {
  connectorInput,
  failureLines,
  initialTemplateDraft,
  missingInput,
  type TemplateDraft,
  TemplateStep,
} from "./CatalogInstallWizard";
import { useCatalogErrorLines } from "./CatalogParts";
import { ConfigForm } from "./config-form/ConfigForm";
import { hasConfigFields } from "./config-form/model";
import { orgConfig } from "./config-form/org";
import { FormError } from "./form-error";

type Problem = { message: string; extra: string[] };

/** The preview plus what its inputs need: the templates by id and the extension with org config. */
interface Loaded {
  preview: UpgradePreview;
  templates: Map<string, OrgCatalogTemplate>;
  /** The plugin's extension, when this upgrade enables it and it has org config. */
  withConfig: OrgExtension | undefined;
}

/** The connector input of a changed template: only the credentials (the connector keeps the rest). */
const credentialsOf = (input: ConnectorInstallInput): ConnectorInstallInput => ({
  ...(input.credential !== undefined && { credential: input.credential }),
  ...(input.client !== undefined && { client: input.client }),
});

/**
 * Upgrading an installed plugin (spec §10): previews the upgrade to `target` (each component added /
 * changed / removed / unchanged), asks for the inputs the preview lists (an added template's
 * connector as at install, re-entered credentials for a template whose auth changed, the
 * extension's org config when the upgrade enables it), then upgrades with the preview's `diffHash`.
 * A stale preview (`plugin.upgrade_stale`) is fetched again and shown with the error; an item that
 * needs approval submits a request (202). The input forms are built from the target version's
 * templates the preview carries (the target is not always the latest version). A failed upgrade
 * names the step (and dependency) and whether this org's components were put back.
 */
export function PluginUpgradeDialog({
  orgId,
  install,
  target,
  open,
  onOpenChange,
  onDone,
}: {
  orgId: string;
  install: { id: string; name: string };
  target: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** After an upgrade (`upgraded`) or a submitted approval request (`requested`). */
  onDone?(result: "upgraded" | "requested"): void;
}) {
  const t = useTranslations("catalog.upgrade");
  const ti = useTranslations("catalog.org.install");
  const tk = useTranslations("catalog.plugins.componentKind");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>({});
  // The extension's config as the form last reported it.
  const [config, setConfig] = useState<{ value: Record<string, unknown>; ok: boolean }>({
    value: {},
    ok: true,
  });
  const [showRequired, setShowRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Problem>();
  /** A stale confirm is fetching the new preview: confirm waits for it. */
  const [refreshing, setRefreshing] = useState(false);
  // The preview, read while the dialog is open; the org's extensions only when the upgrade enables
  // the plugin's extension (a failure there asks no config, as before).
  const previewQ = pluginUpgradePreviewQuery(orgId, install.id, target);
  const previewRead = useQuery({ ...previewQ, enabled: open });
  const needsExtension = previewRead.data?.inputs.extensionConfig === true;
  const extensions = useQuery({ ...orgExtensionsQuery(orgId), enabled: open && needsExtension });
  const upgrade = useAppMutation({
    fn: (body: PluginUpgradeBody) => upgradePlugin(orgId, install.id, body),
    invalidates: () => pluginChangeKeys(orgId),
  });

  /**
   * `plugin.upgrade_failed`: the failed step (in which dependency) and whether this org's
   * components are back at the old version; other errors are translated by code.
   */
  const failureMessage = (e: unknown, from: string): string => {
    if (!(e instanceof ApiClientError) || e.code !== "plugin.upgrade_failed")
      return errorMessage(e);
    const d = (e.rawDetails[0] ?? {}) as Record<string, unknown>;
    const stepName =
      typeof d.step === "string" && ti.has(`step.${d.step}`)
        ? ti(`step.${d.step}`)
        : String(d.step ?? "");
    const code = typeof d.code === "string" ? d.code : "";
    const message =
      d.rolledBack === false
        ? t("failedNoRollback", { step: stepName, code })
        : t("failed", { step: stepName, code, version: versionLabel(from) });
    return typeof d.dependency === "string"
      ? `${message} ${ti("failedIn", { dependency: d.dependency })}`
      : message;
  };

  const problem = (e: unknown, from = ""): Problem => ({
    message: failureMessage(e, from),
    extra: [...failureLines(e), ...catalogLines(e)],
  });

  const loaded: Loaded | "loading" | { problem: Problem } = (() => {
    const preview = previewRead.data;
    if (preview === undefined) {
      return previewRead.error !== null ? { problem: problem(previewRead.error) } : "loading";
    }
    if (needsExtension && extensions.data === undefined && extensions.error === null) {
      return "loading";
    }
    // The target version's templates (the preview carries the ones its inputs name)
    const templates = new Map(preview.templates.map((c) => [c.id, c]));
    // A plugin's extension has the plugin's name
    const ext = needsExtension
      ? extensions.data?.extensions.find((o) => o.plugin === install.name)
      : undefined;
    const withConfig = ext !== undefined && hasConfigFields(ext.orgConfigSchema) ? ext : undefined;
    return { preview, templates, withConfig };
  })();

  // Closed: the next opening starts from a fresh preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on close only
  useEffect(() => {
    if (open) return;
    setError(undefined);
    setShowRequired(false);
    setDrafts({});
    setConfig({ value: {}, ok: true });
    setRefreshing(false);
    qc.removeQueries({ queryKey: previewQ.queryKey });
  }, [open]);

  // Keep what was typed when the preview is read again (a stale confirm reads a new one).
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the preview's answers
  useEffect(() => {
    const preview = previewRead.data;
    if (preview === undefined) return;
    setDrafts((d) => {
      const out: Record<string, TemplateDraft> = {};
      for (const c of preview.templates) {
        out[c.id] = d[c.id] ?? initialTemplateDraft(c, locale, install.name);
      }
      return out;
    });
  }, [previewRead.data]);

  const ready = typeof loaded === "object" && "preview" in loaded ? loaded : undefined;
  const preview = ready?.preview;
  const inputIds = preview
    ? [...preview.inputs.connectors, ...preview.inputs.credentialsChanged]
    : [];
  // Each input template needs its client or credential before confirming (as the kernel checks)
  const incomplete = inputIds.some((id) => {
    const c = ready?.templates.get(id);
    const d = drafts[id];
    if (c === undefined || d === undefined) return true;
    const changed = preview?.inputs.credentialsChanged.includes(id) === true;
    return missingInput(c, d, { personalCredential: !changed }) !== undefined;
  });
  const configErrors = ready?.withConfig !== undefined && !config.ok;

  const templateName = (c: OrgCatalogTemplate) =>
    c.displayName ? displayNameOf({ name: c.id, displayName: c.displayName }, locale) : c.id;

  const confirm = async () => {
    if (preview === undefined || ready === undefined) return;
    if (configErrors) {
      setShowRequired(true);
      return;
    }
    const connectors: Record<string, ConnectorInstallInput> = {};
    for (const id of preview.inputs.connectors) {
      const c = ready.templates.get(id);
      const d = drafts[id];
      if (c !== undefined && d !== undefined) connectors[id] = connectorInput(c, d);
    }
    for (const id of preview.inputs.credentialsChanged) {
      const c = ready.templates.get(id);
      const d = drafts[id];
      if (c === undefined || d === undefined) continue;
      const input = credentialsOf(connectorInput(c, d));
      if (Object.keys(input).length > 0) connectors[id] = input;
    }
    const body: PluginUpgradeBody = {
      version: preview.to,
      diffHash: preview.diffHash,
      ...(Object.keys(connectors).length > 0 && { connectors }),
      ...(ready.withConfig !== undefined && { extensionConfig: config.value }),
    };
    setSubmitting(true);
    setError(undefined);
    try {
      const r = await upgrade.mutateAsync(body);
      if ("request" in r) {
        toast.success(t("requested"));
        onDone?.("requested");
      } else {
        toast.success(t("done", { name: install.name, version: versionLabel(preview.to) }));
        onDone?.("upgraded");
      }
      onOpenChange(false);
    } catch (e) {
      setError(problem(e, preview.from));
      // The catalog or this install changed since the preview: show the new one
      if (e instanceof ApiClientError && e.code === "plugin.upgrade_stale") {
        setRefreshing(true);
        void previewRead.refetch().finally(() => setRefreshing(false));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const changes = preview?.components.filter((c) => c.change !== "unchanged") ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title", { name: install.name })}
      size={640}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={submitting || refreshing || ready === undefined || incomplete}
            onClick={() => void confirm()}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      {loaded === "loading" ? (
        <Stack gap={8}>
          <Text tone="muted">{t("loading")}</Text>
          <Skeleton rows={3} />
        </Stack>
      ) : "problem" in loaded ? (
        <FormError message={loaded.problem.message} extra={loaded.problem.extra} />
      ) : (
        <Stack gap={16}>
          <Text>
            {t("versions", {
              from: versionLabel(loaded.preview.from),
              to: versionLabel(loaded.preview.to),
            })}
          </Text>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("changes")}
            </Text>
            {changes.length === 0 && <Text variant="small">{t("noChanges")}</Text>}
            {changes.map((c) => {
              const line = t("line", {
                change: t(`change.${c.change}`),
                kind: tk(c.kind),
                ref: c.ref,
              });
              return (
                <Text key={`${c.kind}:${c.ref}`} variant="small">
                  {c.detail === undefined ? line : `${line} — ${c.detail}`}
                </Text>
              );
            })}
          </Stack>
          {inputIds.map((id) => {
            const c = loaded.templates.get(id);
            const d = drafts[id];
            if (c === undefined || d === undefined) return null;
            const changed = loaded.preview.inputs.credentialsChanged.includes(id);
            return (
              <Card
                key={id}
                title={
                  changed
                    ? t("credentialsInput", { name: templateName(c) })
                    : t("connectorsInput", { name: templateName(c) })
                }
              >
                <TemplateStep
                  template={c}
                  draft={d}
                  onChange={(next) => setDrafts((all) => ({ ...all, [id]: next }))}
                  credentialsOnly={changed}
                />
              </Card>
            );
          })}
          {loaded.withConfig !== undefined && (
            <Card
              title={extensionLabel(
                { name: loaded.withConfig.plugin, displayName: loaded.withConfig.displayName },
                labelLocale(locale),
              )}
            >
              <Stack gap={8}>
                <Text variant="small" tone="muted">
                  {t("extensionConfig")}
                </Text>
                <ConfigForm
                  schema={loaded.withConfig.orgConfigSchema}
                  value={config.value}
                  showRequired={showRequired}
                  onChange={(value, _entries, state) =>
                    setConfig({ value: orgConfig(value), ok: state.problems.length === 0 })
                  }
                />
              </Stack>
            </Card>
          )}
          {error !== undefined && <FormError message={error.message} extra={error.extra} />}
        </Stack>
      )}
    </Dialog>
  );
}
