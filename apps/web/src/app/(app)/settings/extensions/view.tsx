"use client";

import {
  Button,
  FormSection,
  SettingsPage,
  Stack,
  Switch,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ConfigForm } from "../../../../components/config-form/ConfigForm";
import { hasConfigFields } from "../../../../components/config-form/model";
import { orgConfig, orgFormMeta } from "../../../../components/config-form/org";
import { FilePreviewersSection } from "../../../../components/FilePreviewersSection";
import { FormError } from "../../../../components/form-error";
import { PermissionReview } from "../../../../components/PermissionReview";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { Link } from "../../../../i18n/navigation";
import { ApiClientError, configIssues, issueLines } from "../../../../lib/api";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  type OrgExtension,
  type PermissionGroup,
  provides,
  putOrgExtension,
  syncDirectory,
} from "../../../../lib/extensions";
import type { ConfigIssue } from "../../../../lib/json-schema";
import type { OrgFilePreviewer } from "../../../../lib/previewers";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useServerState } from "../../../../lib/use-server-state";

/**
 * `/settings/extensions`: the org's extensions (SettingsPage, admins). One group per
 * extension: the enable switch (with the reason when a dependency is missing or dependents remain;
 * the latter can be force-disabled), the permission list (read-only, sensitive categories
 * highlighted), the org config form, and "Sync now" for directory-sync extensions. An extension
 * that is currently unavailable on the deployment (e.g. disabled by an enterprise admin) shows
 * "Unavailable": the switch is read-only (the org's setting is kept). A required bootstrap plugin
 * shows "Required": the switch is read-only (always on) and its org config can still be set. Below the
 * extensions, the org's file previewers (`file-preview@1`) in order, when any is provided.
 * Both are read on the server (`page.tsx`); a change replaces the item locally.
 */
export default function Plugins({
  orgId,
  initial,
}: {
  orgId: string;
  initial: { extensions: OrgExtension[]; previewers: OrgFilePreviewer[] | null };
}) {
  const scope = usePagePath("org");
  const t = useTranslations("extensions");
  const nav = useOrgSettingsNav();
  const [extensions, set] = useServerState(initial.extensions);
  const replace = (next: OrgExtension) =>
    set(extensions.map((p) => (p.plugin === next.plugin ? next : p)));
  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "settings", href: "/settings/organization" },
          { label: "extensions" },
        ],
        title: t("title"),
      }}
      nav={nav}
      activeNav="extensions"
    >
      {extensions.length === 0 ? (
        <Text tone="muted">{t("empty")}</Text>
      ) : (
        extensions.map((p) => (
          <ExtensionSection key={p.plugin} orgId={orgId} plugin={p} onSaved={replace} />
        ))
      )}
      <FilePreviewersSection orgId={orgId} initial={initial.previewers} />
    </SettingsPage>
  );
}

/** Why enabling / disabling failed (missing dependency / dependents remain), from the error envelope's details. */
type ToggleProblem =
  | { kind: "dependency_missing"; extensionPoints: string[] }
  | { kind: "has_dependents"; extensions: string[] }
  | { kind: "other"; message: string; extra: string[]; catalog?: boolean };

const strings = (raw: unknown[], key: string): string[] => [
  ...new Set(
    raw.flatMap((d) =>
      typeof d === "object" && d !== null && typeof (d as Record<string, unknown>)[key] === "string"
        ? [(d as Record<string, string>)[key] as string]
        : [],
    ),
  ),
];

function ExtensionSection({
  orgId,
  plugin,
  onSaved,
}: {
  orgId: string;
  plugin: OrgExtension;
  onSaved(p: OrgExtension): void;
}) {
  const t = useTranslations("extensions");
  const label = extensionLabel(
    { name: plugin.plugin, displayName: plugin.displayName },
    labelLocale(useLocale()),
  );
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState<"toggle" | "save" | "sync">();
  const [problem, setProblem] = useState<ToggleProblem>();
  const schema = plugin.orgConfigSchema;
  // Bumped after a save: the form starts again from the saved config.
  const [round, setRound] = useState(0);
  const [form, setForm] = useState<{
    config: Record<string, unknown>;
    ok: boolean;
    dirty: boolean;
  }>({ config: orgConfig(plugin.config), ok: true, dirty: false });
  const [saveError, setSaveError] = useState<{
    message: string;
    extra: string[];
    issues: ConfigIssue[];
  }>();
  const hasFields = hasConfigFields(schema);
  const directory = provides(plugin, "directory");
  // 部署上停用（或尚未加载）：只显示组织的启用设置，不能修改
  const unavailable = plugin.available === false;
  const required = plugin.required === true;

  async function toggle(enabled: boolean, force = false) {
    setBusy("toggle");
    setProblem(undefined);
    try {
      const { extension: next } = await putOrgExtension(orgId, plugin.plugin, {
        enabled,
        ...(force ? { force } : {}),
      });
      onSaved(next);
      toast.success(t(enabled ? "enabledToast" : "disabledToast", { plugin: label }));
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "extension.dependency_missing")
        setProblem({
          kind: "dependency_missing",
          extensionPoints: strings(e.rawDetails, "extensionPoint"),
        });
      else if (e instanceof ApiClientError && e.code === "extension.has_dependents")
        setProblem({ kind: "has_dependents", extensions: strings(e.rawDetails, "plugin") });
      else
        setProblem({
          kind: "other",
          message: errorMessage(e),
          extra: issueLines(e),
          // Refused by the catalog item that brought it into the deployment (disabled / needs
          // approval, the strictest wins): link to the catalog to request it
          catalog:
            e instanceof ApiClientError &&
            (e.code === "catalog.item_disabled" || e.code === "catalog.approval_required"),
        });
    } finally {
      setBusy(undefined);
    }
  }

  async function save() {
    setBusy("save");
    setSaveError(undefined);
    try {
      const { extension: next } = await putOrgExtension(orgId, plugin.plugin, {
        config: form.config,
      });
      onSaved(next);
      setRound((r) => r + 1);
      toast.success(t("configSaved", { plugin: label }));
    } catch (e) {
      const issues = configIssues(e);
      setSaveError({
        message: errorMessage(e),
        extra: issues.length > 0 ? [] : issueLines(e),
        issues,
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function sync() {
    setBusy("sync");
    try {
      await syncDirectory(orgId, plugin.plugin);
      toast.success(t("syncStarted"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <FormSection
      id={`plugin-${plugin.plugin}`}
      title={label}
      description={[plugin.displayName ? plugin.plugin : null, versionLabel(plugin.version)]
        .filter((x): x is string => x !== null)
        .join(" · ")}
    >
      <Stack direction="row" gap={12} align="center">
        <Switch
          label={t("enableLabel", { plugin: label })}
          checked={plugin.enabled}
          disabled={busy !== undefined || unavailable || required}
          onChange={(on) => void toggle(on)}
        />
        <Text>{plugin.enabled ? t("enabled") : t("disabled")}</Text>
        {required && <Text tone="muted">{t("required")}</Text>}
        {unavailable && <Text tone="warn">{t("unavailable")}</Text>}
      </Stack>
      {required && (
        <Text variant="prose" tone="muted">
          {t("requiredHint")}
        </Text>
      )}
      {unavailable && (
        <Text variant="prose" tone="muted">
          {t("unavailableHint")}
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
              onClick={() => void toggle(false, true)}
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
              <Link href="/catalog">{t("openCatalog")}</Link>
            </Text>
          )}
        </Stack>
      )}
      <Permissions groups={plugin.permissions} plugin={plugin.plugin} />
      {!unavailable && plugin.configurable && hasFields && (
        <Stack gap={12}>
          <Text variant="small" tone="muted">
            {t("configTitle")}
          </Text>
          <ConfigForm
            key={round}
            schema={schema}
            value={plugin.config ?? {}}
            meta={orgFormMeta(plugin.secrets)}
            issues={saveError?.issues ?? []}
            disabled={busy !== undefined}
            onChange={(value, _entries, state) =>
              setForm({
                config: orgConfig(value),
                ok: state.problems.length === 0,
                dirty: state.dirty,
              })
            }
          />
          {saveError !== undefined && (
            <FormError message={saveError.message} extra={saveError.extra} />
          )}
          <Stack direction="row" gap={8}>
            {/* 每个插件一个分组：保存用次级样式，页面不出现多个主操作 */}
            <Button
              variant="secondary"
              loading={busy === "save"}
              disabled={busy !== undefined || !form.dirty || !form.ok}
              aria-label={t("saveLabel", { plugin: label })}
              onClick={() => void save()}
            >
              {t("save")}
            </Button>
          </Stack>
        </Stack>
      )}
      {!unavailable && directory && plugin.enabled && (
        <Stack gap={8}>
          <Text variant="small" tone="muted">
            {t("syncHint")}
          </Text>
          <Stack direction="row">
            <Button
              loading={busy === "sync"}
              disabled={busy !== undefined}
              aria-label={t("syncLabel", { plugin: label })}
              onClick={() => void sync()}
            >
              {t("sync")}
            </Button>
          </Stack>
        </Stack>
      )}
    </FormSection>
  );
}

/** 权限清单（只读，与后台审阅共用 PermissionReview）：按类别分组，敏感类别高亮并写明原因。 */
function Permissions({ groups, plugin }: { groups: PermissionGroup[]; plugin: string }) {
  const t = useTranslations("extensions");
  if (groups.length === 0) return null;
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("permissions")}
      </Text>
      <PermissionReview plugin={plugin} groups={groups} />
    </Stack>
  );
}
