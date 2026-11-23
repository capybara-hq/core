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

/**
 * One extension of the org's Extensions page in a right-side Sheet (spec §6.7: view or edit one
 * object without leaving the list). One status line on top (a pending config), then divided
 * regions: Config (org admins: the overridable deployment fields, following the platform or the
 * org's own copy, with their own save); Status (the state and capabilities, one-line hints, why a
 * switch was refused: a missing dependency, dependents that remain with "Disable anyway", the
 * kernel's reason with a link to Plugins; "Sync now" for an enabled directory-sync extension);
 * Permissions (org admins: folded into one line that opens the full blocks); Tools (the single-tool
 * switches of an enabled extension; members read the states); Appearance (org admins, a plugin that
 * suggests an appearance: "Apply this plugin's appearance"). Members get the Status and Tools
 * regions only.
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
  overrides,
  needsConfig,
  problem,
  busy,
  onClose,
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
  /** The extension has overridable deployment fields: the form is shown (org admins). */
  overrides: boolean;
  needsConfig: boolean;
  problem: ToggleProblem | undefined;
  busy: string | undefined;
  onClose(): void;
  onForceDisable(): void;
  onSync(): void;
  /** 外观 (org admins, a plugin on in the org that suggests an appearance): its action. */
  appearance?: ReactNode;
}) {
  const t = useTranslations("extensions");
  const [overridesDirty, setOverridesDirty] = useState(false);
  const directory = provides(plugin, "directory");
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
      width={overrides ? 720 : 480}
      dirty={overridesDirty}
    >
      {/* One status line, then the regions (spec §6.7): Config, Status, Tools, Permissions */}
      <Stack gap={16}>
        {canEdit && needsConfig && <Callout tone="warn">{t("configFirstHint")}</Callout>}
        {overrides && (
          <Subsection title={t("overrides.title")} variant="divided">
            <OrgOverrideSection orgId={orgId} plugin={plugin.plugin} onDirty={setOverridesDirty} />
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
              <PermissionReview
                plugin={plugin.plugin}
                groups={plugin.permissions}
                {...(plugin.client != null && { clientFiles: plugin.client.files })}
              />
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
 * their role; state only, never a config field.
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
