"use client";

import {
  Button,
  Callout,
  KeyValue,
  Sheet,
  Stack,
  Subsection,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Link } from "../i18n/navigation";
import { type OrgExtension, provides } from "../lib/extensions";
import type { ConfigIssue } from "../lib/json-schema";
import { ConfigForm } from "./config-form/ConfigForm";
import { orgConfig, orgFormMeta } from "./config-form/org";
import { FormError } from "./form-error";
import { OrgOverrideSection } from "./OrgOverrideSection";
import { OrgToolSwitches } from "./OrgToolSwitches";
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
 * without leaving the list). One status line on top (the missing required fields of a pending
 * config), then divided regions: 配置 (org admins: the overridable deployment fields, following
 * the platform or the org's own copy, with their own save); 组织配置 (org admins: the form;
 * 保存配置, and 保存并启用 while
 * the extension is off, in the footer); 状态 (the state and capabilities, one-line hints, why a
 * switch was refused: a missing dependency, dependents that remain with 仍然停用, the kernel's
 * reason with a link to 插件; 立即同步 for an enabled directory-sync extension); 权限 (org admins:
 * folded into one line that opens the full blocks); 工具 (the single-tool switches of an enabled
 * extension; members read the states); 外观 (org admins, a plugin that suggests an appearance:
 * 应用此插件的外观). Members get the 状态 and 工具 regions only.
 * The list page keeps the switch logic; this Sheet only reports the person's actions.
 */
export function OrgExtensionSheet({
  orgId,
  extension: plugin,
  label,
  canEdit,
  superAdmin = false,
  capabilities,
  state,
  platform,
  unavailable,
  configForm,
  overrides,
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
  appearance,
}: {
  orgId: string;
  extension: OrgExtension;
  label: string;
  canEdit: boolean;
  /** The viewer is the super admin: an unavailable extension's next step links to the admin console. */
  superAdmin?: boolean;
  capabilities: string[];
  state: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
  platform: boolean;
  unavailable: boolean;
  configForm: boolean;
  /** The extension has overridable deployment fields: the two-level form is shown (org admins). */
  overrides: boolean;
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
  /** 外观 (org admins, a plugin on in the org that suggests an appearance): its action. */
  appearance?: ReactNode;
}) {
  const t = useTranslations("extensions");
  const [form, setForm] = useState<{
    config: Record<string, unknown>;
    ok: boolean;
    dirty: boolean;
    /** The fields the saved config is missing (read from the pristine form). */
    missing: string[];
  }>({ config: orgConfig(plugin.config), ok: true, dirty: false, missing: [] });
  const [overridesDirty, setOverridesDirty] = useState(false);
  const directory = provides(plugin, "directory");
  const saveEnable = configForm && !plugin.enabled && !locked;
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={label}
      mark={{ text: label, image: plugin.icon ?? null }}
      meta={[plugin.displayName ? plugin.plugin : null, versionLabel(plugin.version)]
        .filter((x): x is string => x !== null)
        .join(" · ")}
      width={configForm || overrides ? 720 : 480}
      dirty={form.dirty || overridesDirty}
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
      {/* One status line, then the regions (spec §6.7): 配置, 组织配置, 状态, 工具, 权限 */}
      <Stack gap={16}>
        {canEdit && needsConfig && (
          <Callout tone="warn">
            {form.missing.length > 0
              ? t("missingRequired", { fields: form.missing.join(t("listSep")) })
              : t("configFirstHint")}
          </Callout>
        )}
        {overrides && (
          <Subsection title={t("overrides.title")} variant="divided">
            <OrgOverrideSection orgId={orgId} plugin={plugin.plugin} onDirty={setOverridesDirty} />
          </Subsection>
        )}
        {configForm && (
          <Subsection title={t("configTitle")} variant="divided">
            <ConfigForm
              key={round}
              schema={plugin.orgConfigSchema}
              value={plugin.config ?? {}}
              meta={orgFormMeta(plugin.secrets)}
              issues={saveError?.issues ?? []}
              disabled={busy !== undefined}
              onChange={(value, _entries, s) =>
                setForm((prev) => ({
                  config: orgConfig(value),
                  ok: s.problems.length === 0,
                  dirty: s.dirty,
                  missing: s.dirty
                    ? prev.missing
                    : [
                        ...new Set(
                          s.problems
                            .filter((p) => p.kind === "required" || p.kind === "minItems")
                            .map((p) => p.label),
                        ),
                      ],
                }))
              }
            />
            {saveError !== undefined && (
              <FormError message={saveError.message} extra={saveError.extra} />
            )}
          </Subsection>
        )}
        <Subsection title={t("stateTitle")} variant="divided">
          {/* The state is the region's first line (its heading names it), then the facts */}
          <Text tone={state.tone}>{state.label}</Text>
          <KeyValue
            rows={[
              {
                k: t("capabilitiesTitle"),
                v: capabilities.length > 0 ? capabilities.join(" · ") : "—",
              },
            ]}
          />
          {platform && (
            <Text variant="small" tone="muted">
              {t("platformHint")}
            </Text>
          )}
          {unavailable && (
            <UnavailableNext
              reason={plugin.reason}
              plugin={plugin.plugin}
              role={superAdmin ? "superAdmin" : canEdit ? "orgAdmin" : "member"}
            />
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
        </Subsection>
        {appearance !== undefined && (
          <Subsection title={t("appearanceTitle")} variant="divided">
            {appearance}
          </Subsection>
        )}
        {plugin.enabled && !unavailable && (
          <OrgToolSwitches orgId={orgId} plugin={plugin.plugin} canEdit={canEdit} />
        )}
        {canEdit && plugin.permissions.length > 0 && (
          <Subsection title={t("permissions")} variant="divided">
            <PermissionSummary groups={plugin.permissions}>
              <PermissionReview plugin={plugin.plugin} groups={plugin.permissions} />
            </PermissionSummary>
          </Subsection>
        )}
      </Stack>
    </Sheet>
  );
}

/**
 * Why an unavailable extension cannot be used and what the viewer does next (Platform tool spec
 * §14.5 item 4): the super admin gets the admin console link, org admins and members a step for
 * their role; state only, never a config field. Without a reason (an older kernel) the old hint.
 */
function UnavailableNext({
  reason,
  plugin,
  role,
}: {
  reason: OrgExtension["reason"];
  plugin: string;
  role: "superAdmin" | "orgAdmin" | "member";
}) {
  const t = useTranslations("extensions");
  if (reason === undefined) {
    return (
      <Text variant="small" tone="muted">
        {t("unavailableHint")}
      </Text>
    );
  }
  if (reason === "loading" || reason === "pending_migration") {
    return (
      <Text variant="small" tone="muted">
        {t("unavailableNext.wait")}
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      <Text variant="small" tone="muted">
        {t(`unavailableNext.${role}`)}
      </Text>
      {role === "superAdmin" && (
        <Text>
          <Link href={`/admin/extensions/${encodeURIComponent(plugin)}`}>{t("openAdmin")}</Link>
        </Text>
      )}
    </Stack>
  );
}
