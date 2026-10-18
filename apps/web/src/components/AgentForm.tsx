"use client";

import {
  Card,
  Field,
  FormSection,
  Input,
  Select,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  type AgentDefinitionInput,
  type AgentVisibility,
  type AgentWarning,
  createAgent,
  findModel,
  keepDeclared,
  listModels,
  type ModelParameter,
  type ParamValue,
  type ProviderModels,
} from "../lib/agents";
import { ApiClientError } from "../lib/api";
import type { ModelRef } from "../lib/conversations";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";
import { ModelParams } from "./ModelParams";

const VISIBILITIES = ["private", "org"] as const satisfies readonly AgentVisibility[];
const NAME_MAX = 80;

type Params = Record<string, ParamValue>;
type ParamField = "modelParams" | "fallbackParams";
/** 参数字段的校验错误：键 → 文案。 */
type FieldErrors = Record<ParamField, Record<string, string>>;
const NO_FIELD_ERRORS: FieldErrors = { modelParams: {}, fallbackParams: {} };

/** 下拉框的值：`provider/model`（供应商插件名不含 `/`，模型 id 可能含）。 */
const encode = (r: ModelRef) => `${r.provider}/${r.model}`;
function decode(v: string): ModelRef | null {
  const i = v.indexOf("/");
  return i <= 0 ? null : { provider: v.slice(0, i), model: v.slice(i + 1) };
}

/** {@link useAgentForm} 的结果：页面把它们放进 FormPage（锚点、分组、ActionRow）。 */
export type AgentFormView = {
  anchors: { id: string; label: string; error?: boolean }[];
  /** 表单分组（FormSection），作为 FormPage 的 children。 */
  sections: ReactNode;
  /** ActionRow：未保存改动数与错误数。 */
  unsaved: number;
  errors: number;
  /** 保存成功但有警告：主操作改为「继续」（调用 onDone），不再重复创建。 */
  saved: boolean;
  submit(): void;
  pending: boolean;
  canSubmit: boolean;
};

/**
 * 新建 agent 的表单状态与分组：模型下拉框来自 `GET /models`，兜底模型可选；主模型与兜底模型
 * 各有一个参数分组，按所选模型的声明渲染（换模型时丢弃新模型没有声明的键）。保存成功且没有
 * 警告时调用 `onDone`；有警告（如 `fallback_same_provider`）时在表单顶部以 danger 卡片列出，
 * 由用户点「继续」再调用 `onDone`。
 */
export function useAgentForm(orgId: string, onDone: () => void): AgentFormView {
  const t = useTranslations("agents");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [providers, setProviders] = useState<ProviderModels[]>();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  const [model, setModel] = useState("");
  const [fallback, setFallback] = useState("");
  const [modelParams, setModelParams] = useState<Params>({});
  const [fallbackParams, setFallbackParams] = useState<Params>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [nameError, setNameError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [otherErrors, setOtherErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<AgentWarning[]>();

  useEffect(() => {
    let disposed = false;
    listModels(orgId).then(
      (r) => {
        if (disposed) return;
        setProviders(r.providers);
        // 与原生下拉框一致：默认选中第一个模型
        const first = r.providers.find((p) => p.models.length > 0);
        const m = first?.models[0];
        if (first && m) setModel((cur) => cur || encode({ provider: first.provider, model: m.id }));
      },
      (e: unknown) => {
        if (!disposed) setError(errorMessage(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, errorMessage]);

  /** 下拉框值对应模型的参数声明（未选或找不到时为空）。 */
  const declOf = (v: string): ModelParameter[] => {
    const ref = decode(v);
    return (ref && providers && findModel(providers, ref)?.parameters) || [];
  };
  const modelDecl = declOf(model);
  const fallbackDecl = declOf(fallback);

  function onModelChange(v: string) {
    setModel(v);
    setModelParams((p) => keepDeclared(declOf(v), p));
    setFieldErrors((e) => ({ ...e, modelParams: {} }));
  }

  function onFallbackChange(v: string) {
    setFallback(v);
    // 没有兜底模型时 fallbackParams 必须为空（内核会拒绝）
    setFallbackParams((p) => (v === "" ? {} : keepDeclared(declOf(v), p)));
    setFieldErrors((e) => ({ ...e, fallbackParams: {} }));
  }

  /** 把 `validation_failed` 的 details 映射到参数字段；对不上界面字段的单独列出。 */
  function showDetails(err: unknown) {
    if (!(err instanceof ApiClientError) || err.code !== "validation_failed") return;
    const decl: Record<ParamField, ModelParameter[]> = {
      modelParams: modelDecl,
      fallbackParams: fallbackDecl,
    };
    const fields: FieldErrors = { modelParams: {}, fallbackParams: {} };
    const others: string[] = [];
    for (const d of err.details) {
      const dot = d.path.indexOf(".");
      if (dot < 0) continue;
      const field = d.path.slice(0, dot) as ParamField;
      const key = d.path.slice(dot + 1);
      if (!Object.hasOwn(fields, field)) continue;
      if (decl[field].some((p) => p.key === key)) fields[field][key] = t("params.invalid");
      else others.push(t("params.invalidKey", { key }));
    }
    setFieldErrors(fields);
    setOtherErrors(others);
  }

  const options = (providers ?? []).flatMap((p) =>
    p.models.map((m) => ({
      value: encode({ provider: p.provider, model: m.id }),
      label: `${p.provider} / ${m.displayName || m.id}`,
    })),
  );
  const noModels = providers !== undefined && options.length === 0;
  const canSubmit = !pending && providers !== undefined && !noModels;

  async function save() {
    if (!canSubmit || warnings !== undefined) return;
    const main = decode(model);
    if (main === null) return;
    const trimmed = name.trim();
    setNameError(trimmed === "");
    if (trimmed === "") return;
    const fb = decode(fallback);
    const definition: AgentDefinitionInput = {
      name: trimmed,
      instructions,
      model: main,
      fallback: fb,
      modelParams,
      fallbackParams: fb === null ? {} : fallbackParams,
    };
    setPending(true);
    setError(undefined);
    setFieldErrors(NO_FIELD_ERRORS);
    setOtherErrors([]);
    try {
      const res = await createAgent(orgId, { definition, visibility });
      if (res.warnings.length === 0) onDone();
      else setWarnings(res.warnings);
    } catch (err) {
      setError(errorMessage(err));
      showDetails(err);
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void save();
  }

  const paramErrors = {
    modelParams: Object.keys(fieldErrors.modelParams).length,
    fallbackParams: Object.keys(fieldErrors.fallbackParams).length,
  };
  const errors =
    (nameError ? 1 : 0) + paramErrors.modelParams + paramErrors.fallbackParams + otherErrors.length;
  const unsaved =
    warnings !== undefined
      ? 0
      : [name.trim() !== "", instructions !== "", visibility !== "private", fallback !== ""].filter(
          Boolean,
        ).length +
        Object.keys(modelParams).length +
        Object.keys(fallbackParams).length;

  const anchors: AgentFormView["anchors"] = [
    { id: "basic", label: t("form.basicSection"), error: nameError },
    { id: "model", label: t("form.modelSection"), error: noModels },
    ...(modelDecl.length > 0
      ? [{ id: "params", label: t("form.modelParamsTitle"), error: paramErrors.modelParams > 0 }]
      : []),
    ...(fallbackDecl.length > 0
      ? [
          {
            id: "fallback-params",
            label: t("form.fallbackParamsTitle"),
            error: paramErrors.fallbackParams > 0,
          },
        ]
      : []),
  ];

  const sections = (
    <form onSubmit={onSubmit} noValidate>
      <Stack gap={16}>
        {warnings !== undefined && (
          <Card tone="danger" title={t("form.warningsTitle")}>
            <Stack gap={4}>
              {warnings.map((w) => (
                <Text key={w} tone="warn">
                  {`‖ ${t.has(`warnings.${w}`) ? t(`warnings.${w}`) : t("warnings.unknown", { code: w })}`}
                </Text>
              ))}
            </Stack>
          </Card>
        )}
        {error !== undefined && <FormError message={error} extra={otherErrors} />}
        <div>
          <FormSection
            id="basic"
            title={t("form.basicSection")}
            description={t("form.basicSectionHint")}
          >
            <Field
              label={t("form.nameLabel")}
              required
              count={{ value: name.length, max: NAME_MAX }}
              {...(nameError ? { error: t("form.nameRequired") } : {})}
            >
              <Input
                name="name"
                maxLength={NAME_MAX}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (e.target.value.trim() !== "") setNameError(false);
                }}
              />
            </Field>
            <Field label={t("form.instructionsLabel")} optional help={t("form.instructionsHelp")}>
              <Textarea
                code
                name="instructions"
                rows={6}
                maxLength={100_000}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </Field>
            <Field label={t("form.visibilityLabel")}>
              <Select
                name="visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as AgentVisibility)}
                options={VISIBILITIES.map((v) => ({ value: v, label: t(`form.visibility.${v}`) }))}
              />
            </Field>
          </FormSection>
          <FormSection
            id="model"
            title={t("form.modelSection")}
            description={t("form.modelSectionHint")}
          >
            <Field
              label={t("form.modelLabel")}
              required
              {...(noModels ? { error: t("form.noModels") } : {})}
            >
              <Select
                name="model"
                disabled={providers === undefined}
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                options={options}
              />
            </Field>
            <Field label={t("form.fallbackLabel")} optional>
              <Select
                name="fallback"
                value={fallback}
                onChange={(e) => onFallbackChange(e.target.value)}
                options={[{ value: "", label: t("form.fallbackNone") }, ...options]}
              />
            </Field>
          </FormSection>
          {modelDecl.length > 0 && (
            <FormSection
              id="params"
              title={t("form.modelParamsTitle")}
              description={t("form.paramsSectionHint")}
            >
              <ModelParams
                parameters={modelDecl}
                value={modelParams}
                onChange={setModelParams}
                locale={locale}
                errors={fieldErrors.modelParams}
              />
            </FormSection>
          )}
          {fallbackDecl.length > 0 && (
            <FormSection
              id="fallback-params"
              title={t("form.fallbackParamsTitle")}
              description={t("form.paramsSectionHint")}
            >
              <ModelParams
                parameters={fallbackDecl}
                value={fallbackParams}
                onChange={setFallbackParams}
                locale={locale}
                errors={fieldErrors.fallbackParams}
              />
            </FormSection>
          )}
        </div>
      </Stack>
    </form>
  );

  return {
    anchors,
    sections,
    unsaved,
    errors,
    saved: warnings !== undefined,
    submit: () => void save(),
    pending,
    canSubmit,
  };
}
