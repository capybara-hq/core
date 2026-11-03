"use client";

import { Button, Callout, Stack, Text, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "../i18n/navigation";
import { type DeploymentConfigView, putExtensionConfig } from "../lib/admin-extensions";
import { ApiClientError, configIssues } from "../lib/api";
import type { ConfigIssue } from "../lib/json-schema";
import { useErrorMessage } from "../lib/use-error-message";
import { useServerState } from "../lib/use-server-state";
import { ConfigForm, type ConfigFormState, type ConfigSecretEntry } from "./config-form/ConfigForm";
import { deploymentBody, deploymentForm, reloads } from "./config-form/deployment";
import { buildTree, fromDraft, toDraft } from "./config-form/model";
import { FormError } from "./form-error";

/**
 * The "Config" tab of an extension: its deployment config (D8 / C10), drawn by the one config
 * form renderer. Fields given by the startup config (file / Nacos / environment variables) are
 * read-only and name their source; secrets only show whether they are set and can be replaced or
 * cleared (a record drawn per item, such as an endpoint's API key, per key); hot fields apply on
 * save, the others reload the extension after saving (up to about the drain time limit).
 */
export function ExtensionDeploymentConfig({
  drainSeconds,
  initial,
  pending = false,
  onChanged,
}: {
  drainSeconds: number;
  /** Read on the server; `null` when that read failed (the tab draws its own error). */
  initial: DeploymentConfigView | null;
  /** The extension waits for config: a callout lists the missing fields. */
  pending?: boolean;
  /** The config was saved: the page re-renders on the server (readiness may have changed). */
  onChanged(): void;
}) {
  const t = useTranslations("admin.extensions.config");
  const te = useTranslations("admin.extensions");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [view, set] = useServerState(initial);
  if (view === null)
    return (
      <Stack gap={8}>
        <FormError message={te("loadFailed")} />
        <Stack direction="row">
          <Button density="dense" onClick={() => startTransition(() => router.refresh())}>
            {te("retry")}
          </Button>
        </Stack>
      </Stack>
    );
  if (!view.configurable || view.fields.length === 0) return <Text tone="muted">{t("none")}</Text>;
  return (
    <DeploymentConfigForm
      key={JSON.stringify(view)}
      view={view}
      drainSeconds={drainSeconds}
      pending={pending}
      onSaved={(next) => {
        set(next);
        onChanged();
      }}
    />
  );
}

function DeploymentConfigForm({
  view,
  drainSeconds,
  pending,
  onSaved,
}: {
  view: DeploymentConfigView;
  drainSeconds: number;
  pending: boolean;
  onSaved(next: DeploymentConfigView): void;
}) {
  const t = useTranslations("admin.extensions.config");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const form = useMemo(() => deploymentForm(view), [view]);
  const tree = useMemo(() => buildTree(form.schema, locale), [form, locale]);
  // What a save compares against: the opening value as the form reads it back.
  const opened = useMemo(() => {
    const secretSet = (p: string) => form.meta[p]?.secretSet === true;
    return fromDraft(tree, toDraft(tree, form.value), { secretSet });
  }, [tree, form]);
  const [current, setCurrent] = useState<{
    value: unknown;
    entries: ConfigSecretEntry[];
    state: ConfigFormState;
  }>({ value: opened.value, entries: [], state: { problems: opened.problems, dirty: false } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; issues: ConfigIssue[] }>();
  const body = deploymentBody(view, tree, opened.value, current.value, current.entries);
  const changed = Object.keys(body.values).length > 0 || body.secretEntries.length > 0;
  // Fields left empty (inside existing items too) or lists without their minimum of items.
  const missing = [
    ...new Set(
      opened.problems
        .filter((p) => p.kind === "required" || p.kind === "minItems")
        .map((p) => p.label),
    ),
  ];

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await putExtensionConfig(view.plugin, body.values, body.secretEntries);
      toast.success(t("saved"));
      onSaved(next);
    } catch (e) {
      const issues = configIssues(e);
      setError({
        message:
          issues.length > 0 && e instanceof ApiClientError ? t("saveInvalid") : errorMessage(e),
        issues,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={16}>
      {pending && missing.length > 0 && (
        <Callout tone="warn">{t("pendingMissing", { fields: missing.join(t("listSep")) })}</Callout>
      )}
      <Text variant="prose" tone="muted">
        {t("hint")}
      </Text>
      {view.validated && !view.valid && <FormError message={t("invalid")} />}
      {!view.validated && (
        <Text variant="small" tone="muted">
          {t("notValidated")}
        </Text>
      )}
      <ConfigForm
        schema={form.schema}
        value={form.value}
        meta={form.meta}
        issues={error?.issues ?? (view.validated ? view.issues : [])}
        disabled={busy}
        onChange={(value, entries, state) => setCurrent({ value, entries, state })}
      />
      {error !== undefined && <FormError message={error.message} />}
      <Text variant="small" tone="muted">
        {changed
          ? reloads(view, body)
            ? t("willReload", { seconds: drainSeconds })
            : t("appliesNow")
          : t("noChanges")}
      </Text>
      {busy && reloads(view, body) && (
        <Text variant="small" tone="muted">
          {t("saving", { seconds: drainSeconds })}
        </Text>
      )}
      <Stack direction="row" gap={8}>
        <Button
          variant="primary"
          loading={busy}
          disabled={busy || !changed || current.state.problems.length > 0}
          onClick={() => void save()}
        >
          {t("save")}
        </Button>
      </Stack>
    </Stack>
  );
}
