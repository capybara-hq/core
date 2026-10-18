"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useState } from "react";
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
import { ModelParams } from "./ModelParams";

const VISIBILITIES = ["private", "org"] as const satisfies readonly AgentVisibility[];

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

/**
 * 新建 agent：模型下拉框来自 `GET /models`，兜底模型可选；主模型与兜底模型各有一个参数区，
 * 按所选模型的声明渲染（换模型时丢弃新模型没有声明的键）。保存成功且没有警告时调用 `onDone`；
 * 有警告（如 `fallback_same_provider`）时先显示警告，由用户点「继续」再调用 `onDone`。
 */
export function AgentForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const t = useTranslations("agents");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const id = useId();
  const [providers, setProviders] = useState<ProviderModels[]>();
  const [model, setModel] = useState("");
  const [fallback, setFallback] = useState("");
  const [modelParams, setModelParams] = useState<Params>({});
  const [fallbackParams, setFallbackParams] = useState<Params>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
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

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const str = (name: string) => String(data.get(name) ?? "");
    const main = decode(model);
    if (main === null) return;
    const fb = decode(fallback);
    const definition: AgentDefinitionInput = {
      name: str("name").trim(),
      instructions: str("instructions"),
      model: main,
      fallback: fb,
      modelParams,
      fallbackParams: fb === null ? {} : fallbackParams,
    };
    const visibility = str("visibility") as AgentVisibility;
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

  if (warnings !== undefined) {
    return (
      <div className="card" role="status">
        <p>{t("form.warningsTitle")}</p>
        <ul className="warnings">
          {warnings.map((w) => (
            <li key={w}>
              {t.has(`warnings.${w}`) ? t(`warnings.${w}`) : t("warnings.unknown", { code: w })}
            </li>
          ))}
        </ul>
        <button type="button" onClick={onDone}>
          {t("form.continue")}
        </button>
      </div>
    );
  }

  const options = (providers ?? []).flatMap((p) =>
    p.models.map((m) => {
      const value = encode({ provider: p.provider, model: m.id });
      return (
        <option key={value} value={value}>
          {`${p.provider} / ${m.displayName || m.id}`}
        </option>
      );
    }),
  );
  const noModels = providers !== undefined && options.length === 0;

  return (
    <form className="card" onSubmit={onSubmit}>
      <h1>{t("form.title")}</h1>
      <label htmlFor={`${id}-name`}>{t("form.nameLabel")}</label>
      <input id={`${id}-name`} name="name" required maxLength={80} />
      <label htmlFor={`${id}-instructions`}>{t("form.instructionsLabel")}</label>
      <textarea id={`${id}-instructions`} name="instructions" rows={4} maxLength={100_000} />
      <label htmlFor={`${id}-model`}>{t("form.modelLabel")}</label>
      <select
        id={`${id}-model`}
        name="model"
        required
        disabled={providers === undefined}
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
      >
        {options}
      </select>
      {modelDecl.length > 0 && (
        <section className="params" aria-labelledby={`${id}-model-params`}>
          <h2 id={`${id}-model-params`}>{t("form.modelParamsTitle")}</h2>
          <ModelParams
            parameters={modelDecl}
            value={modelParams}
            onChange={setModelParams}
            locale={locale}
            errors={fieldErrors.modelParams}
          />
        </section>
      )}
      <label htmlFor={`${id}-fallback`}>{t("form.fallbackLabel")}</label>
      <select
        id={`${id}-fallback`}
        name="fallback"
        value={fallback}
        onChange={(e) => onFallbackChange(e.target.value)}
      >
        <option value="">{t("form.fallbackNone")}</option>
        {options}
      </select>
      {fallbackDecl.length > 0 && (
        <section className="params" aria-labelledby={`${id}-fallback-params`}>
          <h2 id={`${id}-fallback-params`}>{t("form.fallbackParamsTitle")}</h2>
          <ModelParams
            parameters={fallbackDecl}
            value={fallbackParams}
            onChange={setFallbackParams}
            locale={locale}
            errors={fieldErrors.fallbackParams}
          />
        </section>
      )}
      <label htmlFor={`${id}-visibility`}>{t("form.visibilityLabel")}</label>
      <select id={`${id}-visibility`} name="visibility" defaultValue="private">
        {VISIBILITIES.map((v) => (
          <option key={v} value={v}>
            {t(`form.visibility.${v}`)}
          </option>
        ))}
      </select>
      {noModels && <p className="error">{t("form.noModels")}</p>}
      {error !== undefined && (
        <div role="alert">
          <p className="error">{error}</p>
          {otherErrors.map((m) => (
            <p key={m} className="error">
              {m}
            </p>
          ))}
        </div>
      )}
      <button type="submit" disabled={pending || providers === undefined || noModels}>
        {pending ? t("form.submitting") : t("form.submit")}
      </button>
    </form>
  );
}
