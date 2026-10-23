"use client";

import { Button, Field, Input, Select, Stack, Switch, Textarea } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { JsonSchema } from "../lib/json-schema";

/**
 * 按 JSON Schema 受限子集渲染的配置表单（渠道连接、插件组织级配置共用）。
 *
 * - 只看顶层 `properties`：`string` / `number` / `integer` / `boolean` / `enum` 与 `required`；
 * - `x-secret` 字段用密码框；编辑时已设置的密钥只显示「已设置」，可「替换」（PATCH 传新值）或「清除」
 *   （PATCH 传 `null`，必填密钥不提供清除），不动 = PATCH 里省略（内核保留原值）；
 * - 其余（对象、数组、联合、`x-unsupported` 等）退回 JSON 文本框。
 *
 * 表单状态是一份草稿：文本类字段存字符串（数字也先存文本，提交时再解析），布尔存 boolean，
 * 编辑模式的密钥 `undefined` = 保留、`null` = 清除、字符串 = 新值。
 */

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "secret" | "json";

export interface SchemaField {
  key: string;
  label: string;
  help?: string;
  kind: FieldKind;
  required: boolean;
  /** `enum` 的取值（原样，可能不是字符串）。 */
  options?: unknown[];
}

export type SchemaDraft = Record<string, string | boolean | null | undefined>;
export type SchemaMode = "create" | "edit";
export type FieldError = "required" | "number" | "integer" | "json";
export type SecretState = { path: string; set: boolean }[];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function kindOf(prop: Obj): FieldKind {
  if (prop["x-secret"] === true) return "secret";
  if (prop["x-unsupported"] === true) return "json";
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return "enum";
  switch (prop.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

/** schema 顶层字段（按 `properties` 的顺序）。 */
export function schemaFields(schema: JsonSchema | null | undefined): SchemaField[] {
  if (!schema || !isObj(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(schema.properties).flatMap(([key, raw]): SchemaField[] => {
    const prop = isObj(raw) ? raw : {};
    const kind = kindOf(prop);
    return [
      {
        key,
        label: typeof prop.title === "string" ? prop.title : key,
        ...(typeof prop.description === "string" ? { help: prop.description } : {}),
        kind,
        required: required.has(key),
        ...(kind === "enum" ? { options: prop.enum as unknown[] } : {}),
      },
    ];
  });
}

/** 由已存配置（没有则 schema 的 default）生成草稿；密钥一律从「保留」开始。 */
export function initialDraft(
  schema: JsonSchema | null | undefined,
  config: Obj | null | undefined,
): SchemaDraft {
  const props = schema && isObj(schema.properties) ? schema.properties : {};
  const draft: SchemaDraft = {};
  for (const f of schemaFields(schema)) {
    const prop = isObj(props[f.key]) ? (props[f.key] as Obj) : {};
    const v = config?.[f.key] !== undefined ? config[f.key] : prop.default;
    switch (f.kind) {
      case "secret":
        draft[f.key] = undefined;
        break;
      case "boolean":
        draft[f.key] = v === true;
        break;
      case "json":
        draft[f.key] = v === undefined ? "" : JSON.stringify(v, null, 2);
        break;
      default:
        draft[f.key] = v === undefined || v === null ? "" : String(v);
    }
  }
  return draft;
}

const isSet = (secrets: SecretState | undefined, key: string) =>
  secrets?.some((s) => s.path === key && s.set) ?? false;

/**
 * 草稿 → 要提交的 `config` 与逐字段错误。创建时省略空字段；编辑时密钥按「保留 → 省略、清除 → null、
 * 替换 → 新值」，空的替换框按保留处理。
 */
export function draftToConfig(
  fields: SchemaField[],
  draft: SchemaDraft,
  mode: SchemaMode,
  secrets?: SecretState,
): { config: Obj; errors: Record<string, FieldError> } {
  const config: Obj = {};
  const errors: Record<string, FieldError> = {};
  for (const f of fields) {
    const v = draft[f.key];
    if (f.kind === "boolean") {
      config[f.key] = v === true;
      continue;
    }
    if (f.kind === "secret") {
      const existing = mode === "edit" && isSet(secrets, f.key);
      if (v === null) {
        if (existing) config[f.key] = null;
      } else if (typeof v === "string" && v !== "") {
        config[f.key] = v;
      } else if (f.required && !existing) {
        errors[f.key] = "required";
      }
      continue;
    }
    const text = typeof v === "string" ? v : "";
    if (text.trim() === "") {
      if (f.required) errors[f.key] = "required";
      continue;
    }
    switch (f.kind) {
      case "number":
      case "integer": {
        const n = Number(text);
        if (!Number.isFinite(n)) errors[f.key] = "number";
        else if (f.kind === "integer" && !Number.isInteger(n)) errors[f.key] = "integer";
        else config[f.key] = n;
        break;
      }
      case "enum":
        config[f.key] = f.options?.find((o) => String(o) === text) ?? text;
        break;
      case "json":
        try {
          config[f.key] = JSON.parse(text);
        } catch {
          errors[f.key] = "json";
        }
        break;
      default:
        config[f.key] = text;
    }
  }
  return { config, errors };
}

/** 草稿里有改动的字段数（与初始草稿相比）。 */
export function changedCount(a: SchemaDraft, b: SchemaDraft): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).length;
}

export function SchemaForm({
  schema,
  draft,
  onChange,
  mode,
  secrets,
  disabled = false,
  showRequired = false,
  readOnly,
}: {
  schema: JsonSchema | null | undefined;
  draft: SchemaDraft;
  onChange(next: SchemaDraft): void;
  mode: SchemaMode;
  /** 编辑模式：内核回显的密钥「是否已设置」。 */
  secrets?: SecretState;
  disabled?: boolean;
  /** 是否显示必填缺失的错误（通常在第一次尝试提交之后）。 */
  showRequired?: boolean;
  /** 只读字段（如部署级配置里由启动配置给出的）：控件禁用，密钥不提供替换 / 清除。 */
  readOnly?: ReadonlySet<string>;
}) {
  const t = useTranslations("schemaForm");
  const fields = schemaFields(schema);
  const { errors } = draftToConfig(fields, draft, mode, secrets);
  const set = (key: string, v: SchemaDraft[string]) => onChange({ ...draft, [key]: v });
  const errorOf = (key: string): string | undefined => {
    const e = errors[key];
    if (e === undefined || (e === "required" && !showRequired)) return undefined;
    return t(`errors.${e}`);
  };

  if (fields.length === 0) return null;
  return (
    <Stack gap={16}>
      {fields.map((f) => {
        const error = errorOf(f.key);
        const common = {
          label: f.label,
          required: f.required,
          ...(f.help !== undefined ? { help: f.help } : {}),
          ...(error !== undefined ? { error } : {}),
        };
        const v = draft[f.key];
        const locked = readOnly?.has(f.key) === true;
        const off = disabled || locked;
        switch (f.kind) {
          case "boolean":
            return (
              <Field key={f.key} {...common}>
                <Switch
                  label={f.label}
                  checked={v === true}
                  disabled={off}
                  onChange={(next) => set(f.key, next)}
                />
              </Field>
            );
          case "enum":
            return (
              <Field key={f.key} {...common}>
                <Select
                  value={typeof v === "string" ? v : ""}
                  disabled={off}
                  onChange={(e) => set(f.key, e.target.value)}
                  options={[
                    ...(f.required ? [] : [{ value: "", label: t("none") }]),
                    ...(f.options ?? []).map((o) => ({ value: String(o), label: String(o) })),
                  ]}
                />
              </Field>
            );
          case "json":
            return (
              <Field key={f.key} {...common} help={f.help ?? t("jsonHint")}>
                <Textarea
                  code
                  rows={4}
                  value={typeof v === "string" ? v : ""}
                  disabled={off}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </Field>
            );
          case "secret":
            return (
              <SecretField
                key={f.key}
                field={f}
                value={v}
                existing={mode === "edit" && isSet(secrets, f.key)}
                disabled={disabled}
                locked={locked}
                {...(error !== undefined ? { error } : {})}
                onChange={(next) => set(f.key, next)}
              />
            );
          default:
            return (
              <Field key={f.key} {...common}>
                <Input
                  type={f.kind === "string" ? "text" : "number"}
                  {...(f.kind === "string" ? {} : { inputMode: "decimal" as const })}
                  value={typeof v === "string" ? v : ""}
                  disabled={off}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </Field>
            );
        }
      })}
    </Stack>
  );
}

/**
 * 密钥字段。创建、或编辑时尚未设置：直接是密码框。编辑时已设置：密码框只读并显示「已设置」，
 * 「替换」后可输入新值（「取消替换」回到保留）；非必填的可「清除」（「撤销」回到保留）。
 */
function SecretField({
  field,
  value,
  existing,
  disabled,
  locked = false,
  error,
  onChange,
}: {
  field: SchemaField;
  value: SchemaDraft[string];
  existing: boolean;
  disabled: boolean;
  /** 只读：密码框禁用（只显示是否已设置），不提供替换 / 清除。 */
  locked?: boolean;
  error?: string;
  onChange(next: string | null | undefined): void;
}) {
  const t = useTranslations("schemaForm");
  const common = {
    label: field.label,
    required: field.required,
    ...(field.help !== undefined ? { help: field.help } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  if (locked) {
    return (
      <Field {...common}>
        <Input
          type="password"
          autoComplete="off"
          value=""
          placeholder={existing ? t("secretSet") : ""}
          disabled
          onChange={() => {}}
        />
      </Field>
    );
  }
  if (!existing) {
    return (
      <Field {...common}>
        <Input
          type="password"
          autoComplete="new-password"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    );
  }
  const replacing = typeof value === "string";
  const clearing = value === null;
  return (
    <Stack gap={8}>
      <Field {...common}>
        <Input
          type="password"
          autoComplete="new-password"
          value={replacing ? value : ""}
          placeholder={clearing ? t("secretWillClear") : replacing ? "" : t("secretSet")}
          disabled={disabled || !replacing}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      <Stack direction="row" gap={8}>
        {replacing || clearing ? (
          <Button
            size={24}
            disabled={disabled}
            aria-label={t(replacing ? "cancelReplaceLabel" : "undoClearLabel", {
              field: field.label,
            })}
            onClick={() => onChange(undefined)}
          >
            {t(replacing ? "cancelReplace" : "undoClear")}
          </Button>
        ) : (
          <>
            <Button
              size={24}
              disabled={disabled}
              aria-label={t("replaceLabel", { field: field.label })}
              onClick={() => onChange("")}
            >
              {t("replace")}
            </Button>
            {!field.required && (
              <Button
                size={24}
                variant="danger"
                disabled={disabled}
                aria-label={t("clearLabel", { field: field.label })}
                onClick={() => onChange(null)}
              >
                {t("clear")}
              </Button>
            )}
          </>
        )}
      </Stack>
    </Stack>
  );
}
