"use client";

import {
  Button,
  Callout,
  DangerConfirm,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import { clearExtensionConfig, putExtensionConfig } from "../lib/admin-extensions";
import { ApiClientError, configIssues } from "../lib/api";
import type { ConfigIssue } from "../lib/json-schema";
import { extensionConfigQuery } from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { ConfigForm, type ConfigFormState, type ConfigSecretEntry } from "./config-form/ConfigForm";
import { deploymentBody, deploymentForm, reloads } from "./config-form/deployment";
import { buildTree, fromDraft, isMissingIssue, toDraft } from "./config-form/model";
import { ExtensionOrgCopies } from "./ExtensionOrgCopies";
import { FormError } from "./form-error";

interface Options {
  name: string;
  drainSeconds: number;
  /** The extension waits for config: one warn line names the missing fields. */
  pending?: boolean;
  /** Read the config (false: the extension has none, nothing is fetched). */
  enabled?: boolean;
  /** The config was saved (the extension's state and the org's readiness may have changed). */
  onChanged(): void;
  /** Drawn in a Sheet: the org copies are a divided region of their own. */
  sheet?: boolean;
}

/** The deployment config's parts, for a page (stacked) or a Sheet (the save in its footer). */
export interface DeploymentConfigParts {
  /** The one warn line naming what is missing (pending config only). */
  notice: ReactNode;
  /** The form with its hints and errors; `null` when the extension has no deployment config. */
  form: ReactNode;
  /**
   * The save action, with 清空配置 beside it while something is stored here (it asks first);
   * `null` until the form is there.
   */
  save: ReactNode;
  /**
   * The orgs holding their own copy of the overridable fields (read only); `null` when the
   * extension has no overridable field.
   */
  copies: ReactNode;
  /** Unsaved changes (a Sheet asks before closing). */
  dirty: boolean;
}

interface Current {
  value: unknown;
  entries: ConfigSecretEntry[];
  state: ConfigFormState;
}

/**
 * The deployment config of an extension (D8 / C10), drawn by the one config form renderer.
 * Fields given by the startup config (file / Nacos / environment variables) are read-only and
 * name their source (one line says so, only when there is such a field); secrets only show
 * whether they are set and can be replaced or cleared (a record drawn per item, such as an
 * endpoint's API key, per key); hot fields apply on save, the others reload the extension after
 * saving (up to about the drain time limit).
 *
 * A pristine form that is merely waiting for config shows one warn line naming the missing
 * fields and no red errors: the view's "missing" issues stay off the fields until a save fails
 * or the person edits a field into an invalid state. Issues that are more than missing values
 * (a stored value that does not validate) still show on their fields.
 */
export function useDeploymentConfig({
  name,
  drainSeconds,
  pending = false,
  enabled = true,
  onChanged,
  sheet = false,
}: Options): DeploymentConfigParts {
  const te = useTranslations("admin.extensions");
  const t = useTranslations("admin.extensions.config");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const qc = useQueryClient();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  // A section of the page's prefetch: a failure is the tab's own error (not read again on mount).
  const q = extensionConfigQuery(name);
  const read = useQuery({ ...q, enabled, retryOnMount: retryOnMountOf(q.queryKey) });
  // Bumped on every save: replacing a secret that is already set returns an identical view, and
  // the form must still start over (the typed value gone, nothing left to save).
  const [saves, setSaves] = useState(0);
  const view = read.data;
  const usable = view?.configurable === true && view.fields.length > 0;
  const formKey = usable ? `${saves}:${JSON.stringify(view)}` : "";
  const form = useMemo(() => (usable ? deploymentForm(view) : null), [usable, view]);
  const tree = useMemo(() => (form ? buildTree(form.schema, locale) : null), [form, locale]);
  // What a save compares against: the opening value as the form reads it back.
  const opened = useMemo(() => {
    if (form === null || tree === null) return null;
    const secretSet = (p: string) => form.meta[p]?.secretSet === true;
    return fromDraft(tree, toDraft(tree, form.value), { secretSet });
  }, [tree, form]);
  // The form's own state belongs to one opening (`formKey`): a new one starts over.
  const [own, setOwn] = useState<{
    key: string;
    current?: Current | undefined;
    error?: { message: string; issues: ConfigIssue[] } | undefined;
  }>({ key: "" });
  const live = own.key === formKey ? own : { key: formKey };
  const setLive = (patch: Partial<Omit<typeof own, "key">>) =>
    setOwn((prev) => ({ ...(prev.key === formKey ? prev : { key: formKey }), ...patch }));
  const [busy, setBusy] = useState(false);
  const put = useAppMutation({
    fn: (v: Parameters<typeof putExtensionConfig>) => putExtensionConfig(...v),
    // a platform change moves what each org copy differs in
    invalidates: (v) => [keys.deployment().extensionOrgOverrides(v[0])],
  });
  const [clearing, setClearing] = useState(false);
  const clear = useAppMutation({
    fn: (plugin: string) => clearExtensionConfig(plugin),
    // the org copies now differ from an emptier platform config
    invalidates: (plugin) => [keys.deployment().extensionOrgOverrides(plugin)],
  });

  if (!enabled) return { notice: null, form: null, save: null, copies: null, dirty: false };
  if (view === undefined) {
    const loading = read.error ? (
      <Stack gap={8}>
        <FormError message={te("loadFailed")} />
        <Stack direction="row">
          <Button density="dense" onClick={() => void read.refetch()}>
            {te("retry")}
          </Button>
        </Stack>
      </Stack>
    ) : (
      <Skeleton rows={4} />
    );
    return { notice: null, form: loading, save: null, copies: null, dirty: false };
  }
  if (!usable || form === null || tree === null || opened === null)
    return { notice: null, form: null, save: null, copies: null, dirty: false };

  const current: Current = live.current ?? {
    value: opened.value,
    entries: [],
    state: { problems: opened.problems, dirty: false },
  };
  const error = live.error;
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
  // The view's missing values are the notice's, never red errors (once the person edits, the
  // form's own checks say what is still missing); other issues show on their fields.
  const viewIssues = view.validated
    ? view.issues.filter((i) => !isMissingIssue(i, form.value))
    : [];
  const readonly = Object.values(form.meta).some((m) => m.readonly !== undefined);
  // Something saved here (values or secrets): only that can be cleared, never the startup config.
  const stored = view.fields.some((f) => f.source === "db");

  const save = async () => {
    setBusy(true);
    setLive({ error: undefined });
    try {
      const next = await put.mutateAsync([view.plugin, body.values, body.secretEntries]);
      toast.success(t("saved"));
      // The answer is the config as it is now: it replaces the cached one.
      qc.setQueryData(q.queryKey, next);
      setSaves((n) => n + 1);
      onChanged();
    } catch (e) {
      const issues = configIssues(e);
      setLive({
        error: {
          message:
            issues.length > 0 && e instanceof ApiClientError ? t("saveInvalid") : errorMessage(e),
          issues,
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const copies = view.fields.some((f) => f.org === "override") ? (
    <ExtensionOrgCopies name={view.plugin} variant={sheet ? "divided" : "guide"} />
  ) : null;

  return {
    notice:
      pending && missing.length > 0 ? (
        // The tinted bar on the extension's page, the warn line in the list's Sheet: the Callout
        // reads the box it sits in (spec §6.19)
        <Callout tone="warn">{t("pendingMissing", { fields: missing.join(t("listSep")) })}</Callout>
      ) : null,
    form: (
      <Stack gap={16}>
        {/* The form's notes as one quiet line over it (read-only fields, not validated now) */}
        {(readonly || !view.validated) && (
          <Text variant="small" tone="muted">
            {[readonly ? t("hint") : null, view.validated ? null : t("notValidated")]
              .filter((x): x is string => x !== null)
              .join(t("noteSep"))}
          </Text>
        )}
        {error === undefined && viewIssues.length > 0 && <FormError message={t("invalid")} />}
        <ConfigForm
          key={formKey}
          schema={form.schema}
          value={form.value}
          meta={form.meta}
          issues={error?.issues ?? viewIssues}
          disabled={busy}
          onChange={(value, entries, state) => setLive({ current: { value, entries, state } })}
        />
        {error !== undefined && <FormError message={error.message} />}
      </Stack>
    ),
    // What saving does sits beside the save (one quiet line), never as a sentence in the form
    save: (
      <Stack direction="row" gap={12} align="center">
        {stored && (
          <Button disabled={busy} onClick={() => setClearing(true)}>
            {t("clear")}
          </Button>
        )}
        {changed && (
          <Text variant="small" tone="muted">
            {busy && reloads(view, body)
              ? t("saving", { seconds: drainSeconds })
              : reloads(view, body)
                ? t("willReload", { seconds: drainSeconds })
                : t("appliesNow")}
          </Text>
        )}
        <Button
          variant="primary"
          loading={busy}
          disabled={busy || !changed || current.state.problems.length > 0}
          onClick={() => void save()}
        >
          {t("save")}
        </Button>
        <DangerConfirm
          open={clearing}
          onOpenChange={setClearing}
          title={t("clearConfirm.title", { name: view.plugin })}
          description={t("clearConfirm.hint")}
          confirmName={view.plugin}
          confirmLabel={t("clearConfirm.confirm")}
          onConfirm={async () => {
            const next = await clear.mutateAsync(view.plugin);
            setClearing(false);
            toast.success(t("cleared"));
            // The answer is the config as it is now: it replaces the cached one.
            qc.setQueryData(q.queryKey, next);
            setSaves((n) => n + 1);
            onChanged();
          }}
        />
      </Stack>
    ),
    copies,
    dirty: changed,
  };
}

/** The "Config" tab of an extension's page: the notice, the form, the save under it. */
export function ExtensionDeploymentConfig(props: Options) {
  const t = useTranslations("admin.extensions.config");
  const parts = useDeploymentConfig(props);
  if (parts.form === null) return <Text tone="muted">{t("none")}</Text>;
  return (
    <Stack gap={16}>
      {parts.notice}
      {parts.form}
      {parts.save !== null && (
        <Stack direction="row" gap={8}>
          {parts.save}
        </Stack>
      )}
      {parts.copies}
    </Stack>
  );
}
