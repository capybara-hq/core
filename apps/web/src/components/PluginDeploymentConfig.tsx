"use client";

import { Button, Skeleton, Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type DeploymentConfigField,
  type DeploymentConfigView,
  getPluginConfig,
  putPluginConfig,
} from "../lib/admin-extensions";
import { ApiClientError, issueLines } from "../lib/api";
import type { JsonSchema } from "../lib/json-schema";
import { useErrorMessage } from "../lib/use-error-message";
import { useLoad } from "../lib/use-load";
import { FormError } from "./form-error";
import {
  changedCount,
  draftToConfig,
  initialDraft,
  type SchemaDraft,
  SchemaForm,
  schemaFields,
} from "./SchemaForm";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 字段点路径在 JSON Schema 里对应的子 schema（沿 `properties` 往下找；找不到返回 undefined）。 */
function subSchema(schema: JsonSchema | null, path: string): Obj | undefined {
  let at: unknown = schema;
  for (const seg of path === "" ? [] : path.split(".")) {
    if (!isObj(at) || !isObj(at.properties)) return undefined;
    at = at.properties[seg];
  }
  return isObj(at) && at !== schema ? at : undefined;
}

/** 没有 schema（插件没在本副本加载）时按当前值推断字段类型。 */
function inferred(value: unknown): Obj {
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    default:
      return value === undefined ? { type: "string" } : { "x-unsupported": true };
  }
}

/**
 * 部署级配置 → SchemaForm 用的扁平 schema：每个字段（点路径）一个顶层属性，标签就是路径，说明里写来源、
 * 是否即时生效（hot）；密钥写是否已设置。不带 default：草稿只反映生效值，没值的留空。
 */
export function flatConfigSchema(
  view: DeploymentConfigView,
  note: (f: DeploymentConfigField) => string,
): JsonSchema {
  const properties: Obj = {};
  for (const f of view.fields) {
    const sub = subSchema(view.schema, f.path);
    const { default: _default, title: _title, description, ...shape } = sub ?? inferred(f.value);
    properties[f.path] = {
      ...(f.secret ? { type: "string", "x-secret": true } : shape),
      title: f.path,
      description: [typeof description === "string" ? description : "", note(f)]
        .filter((s) => s !== "")
        .join(" · "),
    };
  }
  return { type: "object", properties };
}

/**
 * 草稿 → `PUT .../config` 的补丁：只含改动的、非只读的字段；清空的普通字段与清除的密钥为 null，
 * 没动的密钥不出现（内核保留原值）。
 */
export function configPatch(
  schema: JsonSchema,
  view: DeploymentConfigView,
  draft: SchemaDraft,
  baseline: SchemaDraft,
): { values: Obj; errors: number } {
  const fields = schemaFields(schema);
  const secrets = view.fields
    .filter((f) => f.secret)
    .map((f) => ({ path: f.path, set: f.set === true }));
  const { config, errors } = draftToConfig(fields, draft, "edit", secrets);
  const readonly = new Set(view.fields.filter((f) => f.readonly).map((f) => f.path));
  const values: Obj = {};
  for (const f of fields) {
    if (readonly.has(f.key) || draft[f.key] === baseline[f.key]) continue;
    if (f.kind === "secret") {
      if (f.key in config) values[f.key] = config[f.key];
      continue;
    }
    values[f.key] = f.key in config ? config[f.key] : null;
  }
  return { values, errors: Object.keys(errors).length };
}

/**
 * 插件详情的「配置」标签：部署级配置（D8 / C10）。启动配置（文件 / Nacos / 环境变量）给出的字段只读并写明来源；
 * 密钥只显示是否已设置，只能设置新值或清除；hot 字段保存后即时生效，其余保存后插件重新加载（最多约排空时限）。
 */
export function PluginDeploymentConfig({
  name,
  drainSeconds,
}: {
  name: string;
  drainSeconds: number;
}) {
  const t = useTranslations("admin.plugins.config");
  const errorMessage = useErrorMessage();
  const { state, set } = useLoad(() => getPluginConfig(name), [name]);
  if (state.kind === "loading") return <Skeleton rows={4} />;
  if (state.kind === "error")
    return <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />;
  const view = state.data;
  if (!view.configurable || view.fields.length === 0) return <Text tone="muted">{t("none")}</Text>;
  return (
    <ConfigForm
      key={JSON.stringify(view.fields)}
      view={view}
      drainSeconds={drainSeconds}
      onSaved={set}
    />
  );
}

function ConfigForm({
  view,
  drainSeconds,
  onSaved,
}: {
  view: DeploymentConfigView;
  drainSeconds: number;
  onSaved(next: DeploymentConfigView): void;
}) {
  const t = useTranslations("admin.plugins.config");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const note = (f: DeploymentConfigField) =>
    [
      f.secret && !f.readonly ? t(f.set ? "secretSet" : "secretUnset") : t(`source.${f.source}`),
      ...(f.readonly ? [] : [t(f.hot ? "hot" : "reload")]),
    ].join(" · ");
  const [schema] = useState(() => flatConfigSchema(view, note));
  const [baseline] = useState(() =>
    initialDraft(
      schema,
      Object.fromEntries(
        view.fields.filter((f) => !f.secret && f.value !== undefined).map((f) => [f.path, f.value]),
      ),
    ),
  );
  const [draft, setDraft] = useState(baseline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const readOnly = new Set(view.fields.filter((f) => f.readonly).map((f) => f.path));
  const secrets = view.fields
    .filter((f) => f.secret)
    .map((f) => ({ path: f.path, set: f.set === true }));
  const patch = configPatch(schema, view, draft, baseline);
  const dirty = changedCount(draft, baseline) > 0 && Object.keys(patch.values).length > 0;
  const reloads = view.fields.some((f) => !f.hot && f.path in patch.values);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await putPluginConfig(view.plugin, patch.values);
      toast.success(t("saved"));
      onSaved(next);
    } catch (e) {
      setError({ message: errorMessage(e), extra: issueLines(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={16}>
      <Text tone="muted">{t("hint")}</Text>
      {view.validated && !view.valid && (
        <FormError
          message={t("invalid")}
          extra={view.issues.map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`))}
        />
      )}
      {!view.validated && (
        <Text variant="small" tone="muted">
          {t("notValidated")}
        </Text>
      )}
      <SchemaForm
        schema={schema}
        draft={draft}
        onChange={setDraft}
        mode="edit"
        secrets={secrets}
        readOnly={readOnly}
        disabled={busy}
      />
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      {busy && reloads && (
        <Text variant="small" tone="muted">
          {t("saving", { seconds: drainSeconds })}
        </Text>
      )}
      <Stack direction="row" gap={8}>
        <Button
          variant="primary"
          loading={busy}
          disabled={busy || !dirty || patch.errors > 0}
          onClick={() => void save()}
        >
          {t("save")}
        </Button>
      </Stack>
    </Stack>
  );
}
