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
  listOrgPlugins,
  type OrgPlugin,
  type PermissionGroup,
  provides,
  putOrgPlugin,
  syncDirectory,
} from "../../../../../lib/plugins";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/plugins`：组织插件（SettingsPage，管理员）。每个插件一个分组：启用开关（依赖缺失 /
 * 仍有依赖方时给出原因，后者可强制停用）、权限清单（只读，敏感类别高亮）、组织级配置表单、
 * 通讯录插件的「立即同步」。部署上当前不可用的插件（如被企业管理员停用）显示「不可用」：开关只读（组织的启用设置保留）。
 */
export default function PluginsPage() {
  return <OrgGate>{(orgId) => <Plugins key={orgId} orgId={orgId} />}</OrgGate>;
}

function Plugins({ orgId }: { orgId: string }) {
  const t = useTranslations("plugins");
  const errorMessage = useErrorMessage();
  const nav = useSettingsNav();
  const { state, set } = useLoad(() => listOrgPlugins(orgId).then((r) => r.plugins), [orgId]);
  const replace = (next: OrgPlugin) => {
    if (state.kind !== "ready") return;
    set(state.data.map((p) => (p.plugin === next.plugin ? next : p)));
  };
  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="plugins">
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
      ) : state.data.length === 0 ? (
        <Text tone="muted">{t("empty")}</Text>
      ) : (
        state.data.map((p) => (
          <PluginSection key={p.plugin} orgId={orgId} plugin={p} onSaved={replace} />
        ))
      )}
    </SettingsPage>
  );
}

/** 启停失败的原因（依赖缺失 / 仍有依赖方），由错误信封的 details 生成。 */
type ToggleProblem =
  | { kind: "dependency_missing"; capabilities: string[] }
  | { kind: "has_dependents"; plugins: string[] }
  | { kind: "other"; message: string; extra: string[]; directory?: boolean };

const strings = (raw: unknown[], key: string): string[] => [
  ...new Set(
    raw.flatMap((d) =>
      typeof d === "object" && d !== null && typeof (d as Record<string, unknown>)[key] === "string"
        ? [(d as Record<string, string>)[key] as string]
        : [],
    ),
  ),
];

function PluginSection({
  orgId,
  plugin,
  onSaved,
}: {
  orgId: string;
  plugin: OrgPlugin;
  onSaved(p: OrgPlugin): void;
}) {
  const t = useTranslations("plugins");
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

  async function toggle(enabled: boolean, force = false) {
    setBusy("toggle");
    setProblem(undefined);
    try {
      const { plugin: next } = await putOrgPlugin(orgId, plugin.plugin, {
        enabled,
        ...(force ? { force } : {}),
      });
      onSaved(next);
      toast.success(t(enabled ? "enabledToast" : "disabledToast", { plugin: plugin.plugin }));
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "extension.dependency_missing")
        setProblem({
          kind: "dependency_missing",
          capabilities: strings(e.rawDetails, "capability"),
        });
      else if (e instanceof ApiClientError && e.code === "extension.has_dependents")
        setProblem({ kind: "has_dependents", plugins: strings(e.rawDetails, "plugin") });
      else
        setProblem({
          kind: "other",
          message: errorMessage(e),
          extra: issueLines(e),
          // 被把它带进部署的目录条目拒绝（禁用 / 需审批，最严格的生效）：给出去目录申请的入口
          directory:
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
      const { plugin: next } = await putOrgPlugin(orgId, plugin.plugin, { config });
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
          disabled={busy !== undefined || unavailable}
          onChange={(on) => void toggle(on)}
        />
        <Text>{plugin.enabled ? t("enabled") : t("disabled")}</Text>
        {unavailable && <Badge tone="accent">{t("unavailable")}</Badge>}
      </Stack>
      {unavailable && <Text tone="muted">{t("unavailableHint")}</Text>}
      {problem?.kind === "dependency_missing" && (
        <FormError message={t("dependencyMissing")} extra={problem.capabilities} />
      )}
      {problem?.kind === "has_dependents" && (
        <Stack gap={8}>
          <FormError message={t("hasDependents")} extra={problem.plugins} />
          <Stack direction="row">
            <Button
              size={24}
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
          {problem.directory === true && (
            <Text>
              <Link href="/directory">{t("openDirectory")}</Link>
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
  const t = useTranslations("plugins");
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
