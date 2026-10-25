"use client";

import { Button, Card, Dialog, Skeleton, Stack, Text, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  type ConnectorInstallInput,
  displayNameOf,
  type OrgCatalogTemplate,
  type PluginUpgradeBody,
  previewPluginUpgrade,
  type UpgradePreview,
  upgradePlugin,
} from "../lib/catalog";
import { listOrgExtensions, type OrgExtension } from "../lib/extensions";
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
import { FormError } from "./form-error";
import {
  draftToConfig,
  initialDraft,
  type SchemaDraft,
  SchemaForm,
  schemaFields,
} from "./SchemaForm";

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
  onDone(result: "upgraded" | "requested"): void;
}) {
  const t = useTranslations("catalog.upgrade");
  const ti = useTranslations("catalog.org.install");
  const tk = useTranslations("catalog.plugins.componentKind");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const [loaded, setLoaded] = useState<Loaded | "loading" | { problem: Problem }>("loading");
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>({});
  const [config, setConfig] = useState<SchemaDraft>({});
  const [showRequired, setShowRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Problem>();
  const [generation, setGeneration] = useState(0);
  /** A stale confirm is fetching the new preview: confirm waits for it. */
  const [refreshing, setRefreshing] = useState(false);

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
        : t("failed", { step: stepName, code, version: from });
    return typeof d.dependency === "string"
      ? `${message} ${ti("failedIn", { dependency: d.dependency })}`
      : message;
  };

  const problem = (e: unknown, from = ""): Problem => ({
    message: failureMessage(e, from),
    extra: [...failureLines(e), ...catalogLines(e)],
  });

  // Loads the preview when the dialog opens (and again after a stale confirm)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads on open / target / generation
  useEffect(() => {
    if (!open) {
      // Closed: the next opening starts from a fresh preview
      setLoaded("loading");
      setError(undefined);
      setShowRequired(false);
      setDrafts({});
      setConfig({});
      setRefreshing(false);
      return;
    }
    let live = true;
    (async () => {
      const preview = await previewPluginUpgrade(orgId, install.id, target);
      // The target version's templates (the preview carries the ones its inputs name)
      const templates = new Map(preview.templates.map((c) => [c.id, c]));
      let withConfig: OrgExtension | undefined;
      if (preview.inputs.extensionConfig) {
        // A plugin's extension has the plugin's name
        const own = (await listOrgExtensions(orgId).catch(() => ({ extensions: [] }))).extensions;
        const ext = own.find((o) => o.plugin === install.name);
        if (ext !== undefined && schemaFields(ext.orgConfigSchema).length > 0) withConfig = ext;
      }
      return { preview, templates, withConfig };
    })().then(
      (next) => {
        if (!live) return;
        setLoaded(next);
        setRefreshing(false);
        // Keep what was typed when the preview is fetched again
        setDrafts((d) => {
          const out: Record<string, TemplateDraft> = {};
          for (const [id, c] of next.templates) {
            out[id] = d[id] ?? initialTemplateDraft(c, locale, install.name);
          }
          return out;
        });
        setConfig((c) =>
          next.withConfig !== undefined && Object.keys(c).length === 0
            ? initialDraft(next.withConfig.orgConfigSchema, null)
            : c,
        );
      },
      (e: unknown) => {
        if (!live) return;
        setLoaded({ problem: problem(e) });
        setRefreshing(false);
      },
    );
    return () => {
      live = false;
    };
  }, [open, orgId, install.id, target, generation]);

  const ready = typeof loaded === "object" && "preview" in loaded ? loaded : undefined;
  const preview = ready?.preview;
  const inputIds = preview
    ? [...preview.inputs.connectors, ...preview.inputs.credentialsChanged]
    : [];
  // Each input template needs its client or org credential before confirming (as the kernel checks)
  const incomplete = inputIds.some((id) => {
    const c = ready?.templates.get(id);
    const d = drafts[id];
    return c === undefined || d === undefined || missingInput(c, d) !== undefined;
  });
  const configResult = ready?.withConfig
    ? draftToConfig(schemaFields(ready.withConfig.orgConfigSchema), config, "create")
    : undefined;
  const configErrors = configResult !== undefined && Object.keys(configResult.errors).length > 0;

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
      ...(configResult !== undefined && { extensionConfig: configResult.config }),
    };
    setSubmitting(true);
    setError(undefined);
    try {
      const r = await upgradePlugin(orgId, install.id, body);
      if ("request" in r) {
        toast.success(t("requested"));
        onDone("requested");
      } else {
        toast.success(t("done", { name: install.name, version: preview.to }));
        onDone("upgraded");
      }
      onOpenChange(false);
    } catch (e) {
      setError(problem(e, preview.from));
      // The catalog or this install changed since the preview: show the new one
      if (e instanceof ApiClientError && e.code === "plugin.upgrade_stale") {
        setRefreshing(true);
        setGeneration((g) => g + 1);
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
          <Text>{t("versions", { from: loaded.preview.from, to: loaded.preview.to })}</Text>
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
            <Card title={loaded.withConfig.plugin}>
              <Stack gap={8}>
                <Text variant="small" tone="muted">
                  {t("extensionConfig")}
                </Text>
                <SchemaForm
                  schema={loaded.withConfig.orgConfigSchema}
                  draft={config}
                  onChange={setConfig}
                  mode="create"
                  showRequired={showRequired}
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
