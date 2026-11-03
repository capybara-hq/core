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
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ConfigForm } from "../../../../components/config-form/ConfigForm";
import { hasConfigFields } from "../../../../components/config-form/model";
import { orgConfig, orgFormMeta } from "../../../../components/config-form/org";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FilePreviewersSection } from "../../../../components/FilePreviewersSection";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
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
import { orgExtensionsQuery } from "../../../../lib/query/channels";
import { useAppMutation } from "../../../../lib/query/define";
import { keys } from "../../../../lib/query/keys";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/extensions`: the org's extensions (SettingsPage, admins). One group per
 * extension: the enable switch (with the reason when a dependency is missing or dependents remain;
 * the latter can be force-disabled), the permission list (read-only, sensitive categories
 * highlighted), the org config form, and "Sync now" for directory-sync extensions. An extension
 * that is currently unavailable on the deployment (e.g. disabled by an enterprise admin) shows
 * "Unavailable": the switch is read-only (the org's setting is kept). A required bootstrap plugin
 * shows "Required": the switch is read-only (always on) and its org config can still be set. Below the
 * extensions, the org's file previewers (`file-preview@1`) in order, when any is provided.
 * From the query cache (the layout prefetched both on a first load); a change writes the answer
 * into the cached extensions, and enabling or disabling one also invalidates what an extension
 * brings (its UI, its pages, its file previewers).
 */
export default function ExtensionsView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Plugins orgId={ws.orgId} />;
}

/**
 * The extension groups while they load: two, each its enable switch and state word, the hint line
 * a required bootstrap plugin carries (every org has them) and its permissions (the label and the
 * template's default count of permission cards). A config form depends on the extension.
 */
const LOADING_EXTENSIONS = [0, 1].map(() => ({
  fields: [
    { control: "switch" as const },
    { control: "text" as const },
    { control: "card-group" as const },
  ],
}));

function Plugins({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("extensions");
  const nav = useOrgSettingsNav();
  const read = usePageQuery(orgExtensionsQuery(orgId));
  const header = {
    path: [
      ...scope,
      { label: "settings", href: "/settings/organization" },
      { label: "extensions" },
    ],
    title: t("title"),
  };
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="extensions"
        // Two extension groups (titles come with the data).
        loading={{ sections: LOADING_EXTENSIONS }}
      />
    );
  }
  const extensions = read.data.extensions;
  return (
    <SettingsPage header={header} nav={nav} activeNav="extensions">
      {extensions.length === 0 ? (
        <Text tone="muted">{t("empty")}</Text>
      ) : (
        extensions.map((p) => <ExtensionSection key={p.plugin} orgId={orgId} plugin={p} />)
      )}
      <FilePreviewersSection orgId={orgId} />
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

function ExtensionSection({ orgId, plugin }: { orgId: string; plugin: OrgExtension }) {
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
  const qc = useQueryClient();
  // The answer is the extension as it is now: it replaces that one in the cached list.
  const onSaved = (next: OrgExtension) =>
    qc.setQueryData<{ extensions: OrgExtension[] }>(orgExtensionsQuery(orgId).queryKey, (d) =>
      d === undefined
        ? d
        : { ...d, extensions: d.extensions.map((p) => (p.plugin === next.plugin ? next : p)) },
    );
  // Enabling or disabling also changes what the extension brings to the org.
  const put = useAppMutation({
    fn: (v: { enabled?: boolean; force?: boolean; config?: Record<string, unknown> }) =>
      putOrgExtension(orgId, plugin.plugin, v),
    invalidates: (v) => {
      const k = keys.org(orgId);
      return v.enabled === undefined
        ? []
        : [k.contributions(), k.extensionPages(), k.orgFilePreviewers()];
    },
    onSuccess: (r) => onSaved(r.extension),
  });
  const startSync = useAppMutation({
    fn: () => syncDirectory(orgId, plugin.plugin),
    invalidates: () => [],
  });

  async function toggle(enabled: boolean, force = false) {
    setBusy("toggle");
    setProblem(undefined);
    try {
      await put.mutateAsync({ enabled, ...(force ? { force } : {}) });
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
      await put.mutateAsync({ config: form.config });
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
