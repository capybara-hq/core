"use client";

import { Button, KeyValue, Sheet, Stack, Text, versionLabel } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Link } from "../i18n/navigation";
import { type OrgExtension, provides } from "../lib/extensions";
import type { ConfigIssue } from "../lib/json-schema";
import { ConfigForm } from "./config-form/ConfigForm";
import { orgConfig, orgFormMeta } from "./config-form/org";
import { FormError } from "./form-error";
import { PermissionReview } from "./PermissionReview";
import { PermissionSummary } from "./PermissionSummary";

/** Why enabling / disabling failed (missing dependency / dependents remain), from the error envelope's details. */
export type ToggleProblem =
  | { kind: "dependency_missing"; extensionPoints: string[] }
  | { kind: "has_dependents"; extensions: string[] }
  | { kind: "other"; message: string; extra: string[]; catalog?: boolean };

/** A refused config: the form's fields carry the `issues`, the rest is listed. */
export interface SaveError {
  message: string;
  extra: string[];
  issues: ConfigIssue[];
}

/**
 * One extension of the org's 扩展 page in a right-side Sheet (spec §6.7: view or edit one object
 * without leaving the list). For org admins: the org config form on top with 保存配置 (and
 * 保存并启用 while the extension is off) in the footer; the state line with its hints and why a
 * switch was refused (a missing dependency, dependents that remain with 仍然停用, the kernel's
 * reason with a link to 插件); 立即同步 for an enabled directory-sync extension; the permissions
 * folded into one line that opens the full blocks. Members read the capabilities and the state only.
 * The list page keeps the switch logic; this Sheet only reports the person's actions.
 */
export function OrgExtensionSheet({
  extension: plugin,
  label,
  canEdit,
  capabilities,
  state,
  platform,
  unavailable,
  configForm,
  needsConfig,
  locked,
  problem,
  saveError,
  round,
  busy,
  onClose,
  onSave,
  onSaveAndEnable,
  onForceDisable,
  onSync,
}: {
  extension: OrgExtension;
  label: string;
  canEdit: boolean;
  capabilities: string[];
  state: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
  platform: boolean;
  unavailable: boolean;
  configForm: boolean;
  needsConfig: boolean;
  /** The switch is not the org's (platform-wide or not switchable): no 保存并启用. */
  locked: boolean;
  problem: ToggleProblem | undefined;
  saveError: SaveError | undefined;
  /** Bumped after a save: the form starts again from the saved config. */
  round: number;
  busy: string | undefined;
  onClose(): void;
  onSave(config: Record<string, unknown>): void;
  onSaveAndEnable(config: Record<string, unknown>): void;
  onForceDisable(): void;
  onSync(): void;
}) {
  const t = useTranslations("extensions");
  const [form, setForm] = useState<{
    config: Record<string, unknown>;
    ok: boolean;
    dirty: boolean;
  }>({ config: orgConfig(plugin.config), ok: true, dirty: false });
  const directory = provides(plugin, "directory");
  const saveEnable = configForm && !plugin.enabled && !locked;
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={label}
      meta={[plugin.displayName ? plugin.plugin : null, versionLabel(plugin.version)]
        .filter((x): x is string => x !== null)
        .join(" · ")}
      width={configForm ? 720 : 480}
      dirty={form.dirty}
      {...(configForm
        ? {
            footer: (
              <>
                <Button
                  variant={saveEnable ? "secondary" : "primary"}
                  loading={busy === "save"}
                  disabled={busy !== undefined || !form.dirty || !form.ok}
                  aria-label={t("saveLabel", { plugin: label })}
                  onClick={() => onSave(form.config)}
                >
                  {t("save")}
                </Button>
                {saveEnable && (
                  <Button
                    variant="primary"
                    loading={busy === "saveEnable"}
                    disabled={busy !== undefined || !form.ok}
                    aria-label={t("saveAndEnableLabel", { plugin: label })}
                    onClick={() => onSaveAndEnable(form.config)}
                  >
                    {t("saveAndEnable")}
                  </Button>
                )}
              </>
            ),
          }
        : {})}
    >
      <Stack gap={16}>
        {configForm && (
          <Stack gap={12}>
            <Text variant="small" tone="muted">
              {t("configTitle")}
            </Text>
            <ConfigForm
              key={round}
              schema={plugin.orgConfigSchema}
              value={plugin.config ?? {}}
              meta={orgFormMeta(plugin.secrets)}
              issues={saveError?.issues ?? []}
              disabled={busy !== undefined}
              onChange={(value, _entries, s) =>
                setForm({
                  config: orgConfig(value),
                  ok: s.problems.length === 0,
                  dirty: s.dirty,
                })
              }
            />
            {saveError !== undefined && (
              <FormError message={saveError.message} extra={saveError.extra} />
            )}
          </Stack>
        )}
        <KeyValue
          rows={[
            { k: t("stateTitle"), v: <Text tone={state.tone}>{state.label}</Text> },
            {
              k: t("capabilitiesTitle"),
              v: capabilities.length > 0 ? capabilities.join(" · ") : "—",
            },
          ]}
        />
        {platform && (
          <Text variant="prose" tone="muted">
            {t("platformHint")}
          </Text>
        )}
        {unavailable && (
          <Text variant="prose" tone="muted">
            {t("unavailableHint")}
          </Text>
        )}
        {canEdit && needsConfig && (
          <Text variant="prose" tone="muted">
            {t("configFirstHint")}
          </Text>
        )}
        {problem?.kind === "dependency_missing" && (
          <FormError message={t("dependencyMissing")} extra={problem.extensionPoints} />
        )}
        {problem?.kind === "has_dependents" && (
          <Stack gap={8}>
            <FormError message={t("hasDependents")} extra={problem.extensions} />
            <Stack direction="row">
              <Button
                density="dense"
                variant="danger"
                disabled={busy !== undefined}
                onClick={onForceDisable}
              >
                {t("forceDisable")}
              </Button>
            </Stack>
          </Stack>
        )}
        {problem?.kind === "other" && (
          <Stack gap={4}>
            <FormError message={problem.message} extra={problem.extra} />
            {problem.catalog === true && (
              <Text>
                <Link href="/plugins">{t("openPlugins")}</Link>
              </Text>
            )}
          </Stack>
        )}
        {canEdit && !unavailable && directory && plugin.enabled && (
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t("syncHint")}
            </Text>
            <Stack direction="row">
              <Button
                loading={busy === "sync"}
                disabled={busy !== undefined}
                aria-label={t("syncLabel", { plugin: label })}
                onClick={onSync}
              >
                {t("sync")}
              </Button>
            </Stack>
          </Stack>
        )}
        {canEdit && plugin.permissions.length > 0 && (
          <PermissionSummary groups={plugin.permissions}>
            <PermissionReview plugin={plugin.plugin} groups={plugin.permissions} />
          </PermissionSummary>
        )}
      </Stack>
    </Sheet>
  );
}
