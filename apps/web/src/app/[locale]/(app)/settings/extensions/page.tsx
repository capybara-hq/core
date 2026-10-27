"use client";

import {
  Badge,
  Button,
  FormSection,
  SettingsPage,
  Skeleton,
  Stack,
  Switch,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FilePreviewersSection } from "../../../../../components/FilePreviewersSection";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { PermissionReview } from "../../../../../components/PermissionReview";
import {
  changedCount,
  draftToConfig,
  initialDraft,
  SchemaForm,
  schemaFields,
} from "../../../../../components/SchemaForm";
import { useSettingsNav } from "../../../../../components/settings-nav";
import { Link } from "../../../../../i18n/navigation";
import { ApiClientError, issueLines } from "../../../../../lib/api";
import {
  listOrgExtensions,
  type OrgExtension,
  type PermissionGroup,
  provides,
  putOrgExtension,
  syncDirectory,
} from "../../../../../lib/extensions";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/extensions`: the org's extensions (SettingsPage, admins). One group per
 * extension: the enable switch (with the reason when a dependency is missing or dependents remain;
 * the latter can be force-disabled), the permission list (read-only, sensitive categories
 * highlighted), the org config form, and "Sync now" for directory-sync extensions. An extension
 * that is currently unavailable on the deployment (e.g. disabled by an enterprise admin) shows
 * "Unavailable": the switch is read-only (the org's setting is kept). A required bootstrap plugin
 * shows "Required": the switch is read-only (always on) and its org config can still be set. Below the
 * extensions, the org's file previewers (`file-preview@1`) in order, when any is provided.
 */
export default function ExtensionsPage() {
  return <OrgGate>{(orgId) => <Plugins key={orgId} orgId={orgId} />}</OrgGate>;
}

function Plugins({ orgId }: { orgId: string }) {
  const t = useTranslations("extensions");
  const errorMessage = useErrorMessage();
  const nav = useSettingsNav();
  const { state, set } = useLoad(() => listOrgExtensions(orgId).then((r) => r.extensions), [orgId]);
  const replace = (next: OrgExtension) => {
    if (state.kind !== "ready") return;
    set(state.data.map((p) => (p.plugin === next.plugin ? next : p)));
  };
  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="extensions">
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
      ) : state.data.length === 0 ? (
        <Text tone="muted">{t("empty")}</Text>
      ) : (
        state.data.map((p) => (
          <ExtensionSection key={p.plugin} orgId={orgId} plugin={p} onSaved={replace} />
        ))
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
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState<"toggle" | "save" | "sync">();
  const [problem, setProblem] = useState<ToggleProblem>();
  const schema = plugin.orgConfigSchema;
  const [baseline, setBaseline] = useState(() => initialDraft(schema, plugin.config));
  const [draft, setDraft] = useState(baseline);
  const [saveError, setSaveError] = useState<{ message: string; extra: string[] }>();
  const fields = schemaFields(schema);
  const { config, errors } = draftToConfig(fields, draft, "edit", plugin.secrets);
  const dirty = changedCount(draft, baseline);
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
      toast.success(t(enabled ? "enabledToast" : "disabledToast", { plugin: plugin.plugin }));
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
      const { extension: next } = await putOrgExtension(orgId, plugin.plugin, { config });
      const fresh = initialDraft(next.orgConfigSchema, next.config);
      setBaseline(fresh);
      setDraft(fresh);
      onSaved(next);
      toast.success(t("configSaved", { plugin: plugin.plugin }));
    } catch (e) {
      setSaveError({ message: errorMessage(e), extra: issueLines(e) });
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
      title={plugin.plugin}
      description={t("version", { version: plugin.version })}
    >
      <Stack direction="row" gap={12} align="center">
        <Switch
          label={t("enableLabel", { plugin: plugin.plugin })}
          checked={plugin.enabled}
          disabled={busy !== undefined || unavailable || required}
          onChange={(on) => void toggle(on)}
        />
        <Text>{plugin.enabled ? t("enabled") : t("disabled")}</Text>
        {required && <Badge tone="accent">{t("required")}</Badge>}
        {unavailable && <Badge tone="accent">{t("unavailable")}</Badge>}
      </Stack>
      {required && <Text tone="muted">{t("requiredHint")}</Text>}
      {unavailable && <Text tone="muted">{t("unavailableHint")}</Text>}
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
      {!unavailable && plugin.configurable && fields.length > 0 && (
        <Stack gap={12}>
          <Text variant="small" tone="muted">
            {t("configTitle")}
          </Text>
          <SchemaForm
            schema={schema}
            draft={draft}
            onChange={setDraft}
            mode="edit"
            secrets={plugin.secrets}
            disabled={busy !== undefined}
            showRequired={dirty > 0}
          />
          {saveError !== undefined && (
            <FormError message={saveError.message} extra={saveError.extra} />
          )}
          <Stack direction="row" gap={8}>
            {/* 每个插件一个分组：保存用次级样式，页面不出现多个主操作 */}
            <Button
              variant="secondary"
              loading={busy === "save"}
              disabled={busy !== undefined || dirty === 0 || Object.keys(errors).length > 0}
              aria-label={t("saveLabel", { plugin: plugin.plugin })}
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
              aria-label={t("syncLabel", { plugin: plugin.plugin })}
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
