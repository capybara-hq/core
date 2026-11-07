"use client";

import { Badge, Button, Dialog, Skeleton, Stack, Text, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { ApiClientError, configIssues } from "../lib/api";
import {
  type OrgOverrideView,
  putOrgOverrides,
  resetOrgOverrides,
  takeOrgOverrides,
} from "../lib/extensions";
import type { ConfigIssue } from "../lib/json-schema";
import { orgExtensionChangeKeys } from "../lib/query/admin";
import { orgExtensionOverridesQuery } from "../lib/query/channels";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { ConfigForm } from "./config-form/ConfigForm";
import { buildTree, fromDraft, toDraft } from "./config-form/model";
import { overrideForm, overrideValues } from "./config-form/org";
import { FormError } from "./form-error";
import { OrgOverrideDiff } from "./OrgOverrideDiff";

/**
 * The org's two-level deployment config of an extension inside its Sheet (spec A §5.3 to §5.6):
 * the platform's read-only and overridable fields in one form. While the org follows the platform
 * the fields show the platform's values and the first edit says the org will use its own
 * configuration, with its own keys in the same save; with a copy a banner offers 与平台对比 and
 * 使用平台配置 (after a confirmation). The kernel decides what an org may see and write.
 */
export function OrgOverrideSection({
  orgId,
  plugin,
  onDirty,
}: {
  orgId: string;
  plugin: string;
  /** The form has unsaved changes. */
  onDirty(dirty: boolean): void;
}) {
  const t = useTranslations("extensions.overrides");
  const q = orgExtensionOverridesQuery(orgId, plugin);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  if (read.data === undefined) {
    if (read.error)
      return (
        <Stack gap={8}>
          <FormError message={t("loadFailed")} />
          <Stack direction="row">
            <Button density="dense" onClick={() => void read.refetch()}>
              {t("retry")}
            </Button>
          </Stack>
        </Stack>
      );
    return <Skeleton rows={3} />;
  }
  return <Loaded orgId={orgId} plugin={plugin} view={read.data} onDirty={onDirty} />;
}

function Loaded({
  orgId,
  plugin,
  view,
  onDirty,
}: {
  orgId: string;
  plugin: string;
  view: OrgOverrideView;
  onDirty(dirty: boolean): void;
}) {
  const t = useTranslations("extensions.overrides");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const form = useMemo(() => overrideForm(view), [view]);
  const tree = useMemo(() => buildTree(form.schema, locale), [form, locale]);
  // What a save compares against: the opening value as the form reads it back.
  const opened = useMemo(
    () =>
      fromDraft(tree, toDraft(tree, form.value), {
        secretSet: (p) => form.meta[p]?.secretSet === true,
      }),
    [tree, form],
  );
  const [current, setCurrent] = useState<{ value: unknown; ok: boolean; dirty: boolean }>({
    value: opened.value,
    ok: true,
    dirty: false,
  });
  const [rounds, setRounds] = useState(0);
  const [comparing, setComparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<{ message: string; issues: ConfigIssue[] }>();
  const following = view.state === "following";
  const values = overrideValues(view, opened.value, current.value);
  const changed = Object.keys(values).length > 0;

  useEffect(() => onDirty(current.dirty), [current.dirty, onDirty]);

  const qc = keys.org(orgId);
  const invalidates = () => [
    qc.orgExtensionOverrides(plugin),
    qc.orgExtensions(),
    ...orgExtensionChangeKeys(orgId),
  ];
  const save = useAppMutation({
    fn: (v: Record<string, unknown>) => putOrgOverrides(orgId, plugin, v),
    invalidates,
  });
  const take = useAppMutation({
    fn: (path: string) => takeOrgOverrides(orgId, plugin, [path]),
    invalidates,
  });
  const reset = useAppMutation({ fn: () => resetOrgOverrides(orgId, plugin), invalidates });
  const busy = save.isPending || take.isPending || reset.isPending;

  const run = async (
    action: () => Promise<unknown>,
    done: () => void,
    failed: (e: unknown) => void,
  ) => {
    setError(undefined);
    try {
      await action();
      done();
    } catch (e) {
      failed(e);
    }
  };
  const onSave = () =>
    void run(
      () => save.mutateAsync(values),
      () => {
        toast.success(t("saved"));
        setRounds((n) => n + 1);
      },
      (e) => {
        const issues = configIssues(e);
        setError({
          message:
            issues.length > 0 && e instanceof ApiClientError ? t("saveInvalid") : errorMessage(e),
          issues,
        });
      },
    );
  const onTake = (path: string) =>
    void run(
      () => take.mutateAsync(path),
      () => {
        toast.success(t("taken"));
        setRounds((n) => n + 1);
      },
      (e) => setError({ message: errorMessage(e), issues: [] }),
    );
  const onReset = () =>
    void run(
      () => reset.mutateAsync(),
      () => {
        setConfirming(false);
        setComparing(false);
        toast.success(t("resetDone"));
        setRounds((n) => n + 1);
      },
      (e) => {
        setConfirming(false);
        setError({ message: errorMessage(e), issues: [] });
      },
    );

  return (
    <Stack gap={12}>
      {following ? (
        <Stack gap={4}>
          <Stack direction="row" gap={8}>
            <Badge tone="accent">{t("following")}</Badge>
          </Stack>
          <Text variant="prose" tone="muted">
            {t("followingHint")}
          </Text>
        </Stack>
      ) : (
        <Stack gap={8}>
          <Text variant="prose">{t("ownConfig")}</Text>
          <Stack direction="row" gap={8}>
            <Button density="dense" disabled={busy} onClick={() => setComparing((c) => !c)}>
              {t("compare")}
            </Button>
            <Button density="dense" disabled={busy} onClick={() => setConfirming(true)}>
              {t("usePlatform")}
            </Button>
          </Stack>
        </Stack>
      )}
      {!following && comparing && <OrgOverrideDiff view={view} busy={busy} onTake={onTake} />}
      {following && changed && (
        <Text variant="prose" tone="muted">
          {t("firstEdit")}
        </Text>
      )}
      <ConfigForm
        key={`${rounds}:${JSON.stringify(view)}`}
        schema={form.schema}
        value={form.value}
        meta={form.meta}
        issues={error?.issues ?? view.issues}
        disabled={busy}
        onChange={(value, _entries, s) =>
          setCurrent({ value, ok: s.problems.length === 0, dirty: s.dirty })
        }
      />
      {error !== undefined && <FormError message={error.message} />}
      <Stack direction="row" gap={8}>
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={busy || !changed || !current.ok}
          aria-label={t("saveLabel")}
          onClick={onSave}
        >
          {t("save")}
        </Button>
      </Stack>
      {confirming && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirming(false);
          }}
          title={t("usePlatform")}
          danger
          initialFocus="cancel"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t("cancel")}
              </Button>
              <Button variant="danger-solid" loading={reset.isPending} onClick={onReset}>
                {t("usePlatform")}
              </Button>
            </>
          }
        >
          <Text variant="prose">{t("resetBody")}</Text>
        </Dialog>
      )}
    </Stack>
  );
}
