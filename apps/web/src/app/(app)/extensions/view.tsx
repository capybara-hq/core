"use client";

import {
  Button,
  FormSection,
  ListPage,
  Stack,
  Switch,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ConfigForm } from "../../../components/config-form/ConfigForm";
import { hasConfigFields } from "../../../components/config-form/model";
import { orgConfig, orgFormMeta } from "../../../components/config-form/org";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { FilePreviewersSection } from "../../../components/FilePreviewersSection";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { PermissionReview } from "../../../components/PermissionReview";
import { SwitchOffDialog } from "../../../components/PluginSwitch";
import { PointDefaultsSection } from "../../../components/PointDefaultsSection";
import { usePagePath } from "../../../components/shell/path";
import { Link } from "../../../i18n/navigation";
import { ApiClientError, configIssues, issueLines } from "../../../lib/api";
import type { SwitchPreview } from "../../../lib/catalog";
import { extensionLabel, labelLocale } from "../../../lib/extension-label";
import {
  type OrgExtension,
  type PermissionGroup,
  type PutOrgExtensionInput,
  provides,
  putOrgExtension,
  syncDirectory,
} from "../../../lib/extensions";
import type { ConfigIssue } from "../../../lib/json-schema";
import { roleAtLeast } from "../../../lib/members";
import { orgExtensionChangeKeys } from "../../../lib/query/admin";
import { orgExtensionsQuery } from "../../../lib/query/channels";
import { keys } from "../../../lib/query/keys";
import { useAppMutation } from "../../../lib/query/mutation";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

/**
 * `/extensions`: the org's 扩展 page (spec §9; org admins, who read the org's extensions). One
 * group per extension (in a ListPage): the enable switch, which is its plugin's switch (spec §5
 * rule 7): switching it off answers the plugin's switch-off preview first (what it takes away, the
 * agents that use it), confirmed in a dialog with the preview's hash; with the reason when a
 * dependency is missing or dependents remain (the latter can be force-disabled); the permission
 * list (read-only, sensitive categories highlighted), the org config form, and "Sync now" for
 * directory-sync extensions. An extension that is off and whose saved org config lacks a required
 * field cannot be switched on (the switch is read-only with the hint 先填写组织级配置再启用): the
 * form's 保存并启用 saves the config and enables it in one PUT. A refused config
 * (`extension.config_invalid`), from either, marks the form's fields. An extension of an `all` or
 * builtin plugin reads 已启用 · 平台统一 and its switch is read-only (on in every org); its org
 * config can still be set. One the
 * deployment cannot run now (e.g. stopped by a super admin) shows "Unavailable": the switch is
 * read-only (the org's setting is kept). Below the extensions, the org's default providers of the
 * points several extensions provide (web tools spec §6), and the org's file previewers
 * (`file-preview@1`) in order, when any is provided. From the query cache (the layout prefetched
 * all three on a first load); a change writes the answer into the cached extensions, and enabling or
 * disabling one also invalidates what an extension brings (its UI, its pages, its file previewers,
 * the default providers' candidates) and the plugin's view.
 */
export default function ExtensionsView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Extensions orgId={ws.orgId} canEdit={roleAtLeast(ws.role, "admin")} />;
}

function Extensions({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const scope = usePagePath("org");
  const t = useTranslations("extensions");
  const read = usePageQuery(orgExtensionsQuery(orgId));
  const header = {
    path: [...scope, { label: "extensions" }],
    title: t("title"),
    description: t("description"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") return <ListPage header={header} loading />;
  const extensions = read.data.extensions;
  return (
    <ListPage header={header}>
      <Stack gap={24}>
        {extensions.length === 0 ? (
          <Text tone="muted">{t("empty")}</Text>
        ) : (
          extensions.map((p) =>
            canEdit ? (
              <ExtensionSection key={p.plugin} orgId={orgId} plugin={p} />
            ) : (
              <ExtensionReadOnly key={p.plugin} plugin={p} />
            ),
          )
        )}
        {canEdit && <PointDefaultsSection orgId={orgId} />}
        {canEdit && <FilePreviewersSection orgId={orgId} />}
      </Stack>
    </ListPage>
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

/** A member's view of an extension: name, version and state; no switch, config or permissions. */
function ExtensionReadOnly({ plugin }: { plugin: OrgExtension }) {
  const t = useTranslations("extensions");
  const tp = useTranslations("plugins");
  const label = extensionLabel(
    { name: plugin.plugin, displayName: plugin.displayName },
    labelLocale(useLocale()),
  );
  const platform = plugin.required === true || plugin.catalogItem?.scope === "all";
  return (
    <FormSection
      id={`plugin-${plugin.plugin}`}
      title={label}
      description={[plugin.displayName ? plugin.plugin : null, versionLabel(plugin.version)]
        .filter((x): x is string => x !== null)
        .join(" · ")}
    >
      <Stack direction="row" gap={12} align="center">
        <Text>
          {plugin.enabled ? (platform ? tp("state.platform") : t("enabled")) : t("disabled")}
        </Text>
        {plugin.available === false && <Text tone="warn">{t("unavailable")}</Text>}
      </Stack>
    </FormSection>
  );
}

function ExtensionSection({ orgId, plugin }: { orgId: string; plugin: OrgExtension }) {
  const t = useTranslations("extensions");
  const tp = useTranslations("plugins");
  const label = extensionLabel(
    { name: plugin.plugin, displayName: plugin.displayName },
    labelLocale(useLocale()),
  );
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState<"toggle" | "save" | "saveEnable" | "sync">();
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
  // The saved config (the form before any edit) has no client problem, e.g. no required field
  // left unset: read from the form's first report after each (re)mount.
  const [savedOk, setSavedOk] = useState(true);
  const directory = provides(plugin, "directory");
  // Stopped on the deployment (or not loaded yet): only the org's enable setting is shown, read-only
  const unavailable = plugin.available === false;
  const required = plugin.required === true;
  // On in every org (a builtin or `all` plugin): the switch is the platform's
  const platform = required || plugin.catalogItem?.scope === "all";
  const locked = platform || plugin.switchable === false;
  const configForm = !unavailable && plugin.configurable && hasFields;
  // Off and the saved config is incomplete: enabling would be refused, so the switch waits for
  // the config (保存并启用 does both)
  const needsConfig = !plugin.enabled && configForm && !savedOk;
  const qc = useQueryClient();
  // The answer is the extension as it is now: it replaces that one in the cached list.
  const onSaved = (next: OrgExtension) =>
    qc.setQueryData<{ extensions: OrgExtension[] }>(orgExtensionsQuery(orgId).queryKey, (d) =>
      d === undefined
        ? d
        : { ...d, extensions: d.extensions.map((p) => (p.plugin === next.plugin ? next : p)) },
    );
  // Enabling, disabling or configuring also changes what the extension brings to the org (its
  // readiness, UI, models and purposes); the list itself takes the answer.
  // Switching the extension's plugin off answers its switch-off preview first: shown in a dialog,
  // then confirmed with the preview's hash.
  const [off, setOff] = useState<{ input: PutOrgExtensionInput; preview: SwitchPreview } | null>(
    null,
  );
  const [offNotice, setOffNotice] = useState<string>();
  const put = useAppMutation({
    fn: (v: PutOrgExtensionInput) => putOrgExtension(orgId, plugin.plugin, v),
    // (a plugin switch also changes the catalog's view and the installed plugins)
    invalidates: () => [
      ...orgExtensionChangeKeys(orgId),
      keys.org(orgId).catalog(),
      keys.org(orgId).catalogItemsAll(),
      keys.org(orgId).pluginInstalls(),
    ],
    onSuccess: (r) => {
      if ("extension" in r) onSaved(r.extension);
    },
  });
  const startSync = useAppMutation({
    fn: () => syncDirectory(orgId, plugin.plugin),
    invalidates: () => [],
  });

  async function toggle(enabled: boolean, force = false, confirm?: string, keepNotice = false) {
    setBusy("toggle");
    setProblem(undefined);
    const input: PutOrgExtensionInput = {
      enabled,
      ...(force ? { force } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
    };
    try {
      const r = await put.mutateAsync(input);
      if ("preview" in r) {
        setOff({ input: { enabled, ...(force ? { force } : {}) }, preview: r });
        if (!keepNotice) setOffNotice(undefined);
        return;
      }
      setOff(null);
      setOffNotice(undefined);
      toast.success(t(enabled ? "enabledToast" : "disabledToast", { plugin: label }));
    } catch (e) {
      // The preview moved on before the confirm: read it again and show it
      if (off !== null && e instanceof ApiClientError && e.code === "plugin.switch_stale") {
        setOffNotice(tp("switchOff.stale"));
        await toggle(enabled, force, undefined, true);
        return;
      }
      setOff(null);
      refused(e);
    } finally {
      setBusy(undefined);
    }
  }

  /**
   * Why a switch (or 保存并启用) was refused: a refused config marks the form's fields (as when
   * saving), the rest shows under the switch.
   */
  function refused(e: unknown) {
    if (configForm && e instanceof ApiClientError && e.code === "extension.config_invalid") {
      configRefused(e);
      return;
    }
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
        // Refused by its plugin (stopped by the platform, not offered to this org): link to
        // the 插件 page to request it
        catalog:
          e instanceof ApiClientError &&
          (e.code === "plugin.disabled" || e.code === "catalog.approval_required"),
      });
  }

  function configRefused(e: unknown) {
    const issues = configIssues(e);
    setSaveError({
      message: errorMessage(e),
      extra: issues.length > 0 ? [] : issueLines(e),
      issues,
    });
  }

  async function save() {
    setBusy("save");
    setSaveError(undefined);
    try {
      await put.mutateAsync({ config: form.config });
      setRound((r) => r + 1);
      toast.success(t("configSaved", { plugin: label }));
    } catch (e) {
      configRefused(e);
    } finally {
      setBusy(undefined);
    }
  }

  /** 保存并启用: the config and the switch in one PUT (the kernel validates before installing). */
  async function saveAndEnable() {
    setBusy("saveEnable");
    setSaveError(undefined);
    setProblem(undefined);
    try {
      await put.mutateAsync({ enabled: true, config: form.config });
      setRound((r) => r + 1);
      toast.success(t("enabledToast", { plugin: label }));
    } catch (e) {
      refused(e);
    } finally {
      setBusy(undefined);
    }
  }

  async function sync() {
    setBusy("sync");
    try {
      await startSync.mutateAsync(undefined);
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
          disabled={busy !== undefined || unavailable || locked || needsConfig}
          onChange={(on) => void toggle(on)}
        />
        <Text>
          {plugin.enabled ? (platform ? tp("state.platform") : t("enabled")) : t("disabled")}
        </Text>
        {unavailable && <Text tone="warn">{t("unavailable")}</Text>}
      </Stack>
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
      {needsConfig && (
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
              <Link href="/plugins">{t("openPlugins")}</Link>
            </Text>
          )}
        </Stack>
      )}
      <Permissions groups={plugin.permissions} plugin={plugin.plugin} />
      {configForm && (
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
            onChange={(value, _entries, state) => {
              setForm({
                config: orgConfig(value),
                ok: state.problems.length === 0,
                dirty: state.dirty,
              });
              if (!state.dirty) setSavedOk(state.problems.length === 0);
            }}
          />
          {saveError !== undefined && (
            <FormError message={saveError.message} extra={saveError.extra} />
          )}
          <Stack direction="row" gap={8}>
            {/* One group per plugin: saving uses the secondary style, so the page has no several primary actions */}
            <Button
              variant="secondary"
              loading={busy === "save"}
              disabled={busy !== undefined || !form.dirty || !form.ok}
              aria-label={t("saveLabel", { plugin: label })}
              onClick={() => void save()}
            >
              {t("save")}
            </Button>
            {!plugin.enabled && !locked && (
              <Button
                variant="secondary"
                loading={busy === "saveEnable"}
                disabled={busy !== undefined || !form.ok}
                aria-label={t("saveAndEnableLabel", { plugin: label })}
                onClick={() => void saveAndEnable()}
              >
                {t("saveAndEnable")}
              </Button>
            )}
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
      {off !== null && (
        <SwitchOffDialog
          orgId={orgId}
          name={label}
          preview={off.preview.preview}
          busy={busy === "toggle"}
          notice={offNotice}
          onConfirm={() => void toggle(false, off.input.force === true, off.preview.confirm)}
          onCancel={() => {
            setOff(null);
            setOffNotice(undefined);
          }}
        />
      )}
    </FormSection>
  );
}

/** The permission list (read-only, shared with the admin review's PermissionReview): grouped by category, sensitive categories highlighted with their reason. */
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
