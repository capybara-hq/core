"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useState } from "react";
import {
  type AgentDefinitionInput,
  type AgentVisibility,
  type AgentWarning,
  createAgent,
  listModels,
  type ProviderModels,
} from "../lib/agents";
import type { ModelRef } from "../lib/conversations";
import { useErrorMessage } from "../lib/use-error-message";

const VISIBILITIES = ["private", "org"] as const satisfies readonly AgentVisibility[];

/** 下拉框的值：`provider/model`（供应商插件名不含 `/`，模型 id 可能含）。 */
const encode = (r: ModelRef) => `${r.provider}/${r.model}`;
function decode(v: string): ModelRef | null {
  const i = v.indexOf("/");
  return i <= 0 ? null : { provider: v.slice(0, i), model: v.slice(i + 1) };
}

/**
 * 新建 agent：模型下拉框来自 `GET /models`，兜底模型可选。保存成功且没有警告时调用 `onDone`；
 * 有警告（如 `fallback_same_provider`）时先显示警告，由用户点「继续」再调用 `onDone`。
 */
export function AgentForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const t = useTranslations("agents");
  const errorMessage = useErrorMessage();
  const id = useId();
  const [providers, setProviders] = useState<ProviderModels[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<AgentWarning[]>();

  useEffect(() => {
    let disposed = false;
    listModels(orgId).then(
      (r) => {
        if (!disposed) setProviders(r.providers);
      },
      (e: unknown) => {
        if (!disposed) setError(errorMessage(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, errorMessage]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const str = (name: string) => String(data.get(name) ?? "");
    const model = decode(str("model"));
    if (model === null) return;
    const definition: AgentDefinitionInput = {
      name: str("name").trim(),
      instructions: str("instructions"),
      model,
      fallback: decode(str("fallback")),
    };
    const visibility = str("visibility") as AgentVisibility;
    setPending(true);
    setError(undefined);
    try {
      const res = await createAgent(orgId, { definition, visibility });
      if (res.warnings.length === 0) onDone();
      else setWarnings(res.warnings);
    } catch (err) {
      setError(errorMessage(err));
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
      <select id={`${id}-model`} name="model" required disabled={providers === undefined}>
        {options}
      </select>
      <label htmlFor={`${id}-fallback`}>{t("form.fallbackLabel")}</label>
      <select id={`${id}-fallback`} name="fallback" defaultValue="">
        <option value="">{t("form.fallbackNone")}</option>
        {options}
      </select>
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
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending || providers === undefined || noModels}>
        {pending ? t("form.submitting") : t("form.submit")}
      </button>
    </form>
  );
}
