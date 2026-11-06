"use client";

import { Callout, Field, FormSection, Select, Stack } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  type Agent,
  findModel,
  keepDeclared,
  type ModelParameter,
  type ParamValue,
  warningsOf,
} from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import { labelLocale, modelLabel } from "../../lib/extension-label";
import { ModelParams } from "../ModelParams";
import { decodeModel, encodeModel, sameJson, savedDefinition } from "./definition-parts";
import {
  SaveFeedback,
  useDefinitionSave,
  useSectionActionRow,
  WithFormData,
} from "./definition-save";
import type { AgentFormData } from "./form-data";
import { AgentSectionFrame, useAgentPage } from "./frame";
import { ModelReadOnly } from "./ModelReadOnly";
import { useSectionDraft } from "./useSectionDraft";

type Params = Record<string, ParamValue>;
type ParamField = "modelParams" | "fallbackParams";
/** Per params field: key → error text. */
type FieldErrors = Record<ParamField, Record<string, string>>;
const NO_FIELD_ERRORS: FieldErrors = { modelParams: {}, fallbackParams: {} };

/** The Model section's part of the definition, as its selects hold it. */
type Draft = { model: string; fallback: string; modelParams: Params; fallbackParams: Params };
const draftOf = (a: Agent): Draft => ({
  model: encodeModel(a.definition.model),
  fallback: a.definition.fallback ? encodeModel(a.definition.fallback) : "",
  modelParams: { ...(a.definition.modelParams ?? {}) },
  fallbackParams: { ...(a.definition.fallbackParams ?? {}) },
});

/**
 * 模型 Model (agent profile design §3.2): the model, the fallback and each one's parameters, by
 * the chosen model's declarations (a switch drops the keys the new model does not declare). Its
 * save sends the saved definition with only these fields changed. Read-only for someone who may
 * not change the agent.
 */
export function ModelSection() {
  const { editable } = useAgentPage();
  if (!editable) return <ModelReadOnly />;
  return <WithFormData>{(data) => <ModelEdit data={data} />}</WithFormData>;
}

function ModelEdit({ data }: { data: AgentFormData }) {
  const t = useTranslations("agents");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const { agent } = useAgentPage();
  const save = useDefinitionSave();
  const actionRow = useSectionActionRow();
  const saved = draftOf(agent);
  const draft = useSectionDraft(saved);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [otherErrors, setOtherErrors] = useState<string[]>([]);
  const providers = data.providers;
  const d = draft.draft;

  const declOf = (v: string): ModelParameter[] => {
    const ref = decodeModel(v);
    return (ref && findModel(providers, ref)?.parameters) || [];
  };
  const modelDecl = declOf(d.model);
  const fallbackDecl = declOf(d.fallback);
  const edit = (fn: (cur: Draft) => Draft) => {
    save.begin();
    draft.set(fn);
  };

  const options = providers.flatMap((p) =>
    p.models.map((m) => ({
      value: encodeModel({ provider: p.provider, model: m.id }),
      label: modelLabel(
        { name: p.provider, displayName: p.displayName },
        m.displayName || m.id,
        lang,
      ),
    })),
  );
  const noModels = options.length === 0;
  // Persistent hints, live while editing: the draft's fallback against the draft's model. With
  // the model and fallback untouched, the last save's warnings of this section count as well.
  const fb = decodeModel(d.fallback);
  const sameProvider = fb !== null && fb.provider === decodeModel(d.model)?.provider;
  const untouched = d.model === saved.model && d.fallback === saved.fallback;
  const hints = new Set<string>(untouched ? warningsOf("model", save.warnings) : []);
  if (sameProvider) hints.add("fallback_same_provider");

  /** `validation_failed` details on the params fields; the ones no field shows are listed. */
  function showDetails(err: unknown) {
    if (!(err instanceof ApiClientError) || err.code !== "validation_failed") return;
    const decl: Record<ParamField, ModelParameter[]> = {
      modelParams: modelDecl,
      fallbackParams: fallbackDecl,
    };
    const fields: FieldErrors = { modelParams: {}, fallbackParams: {} };
    const others: string[] = [];
    for (const x of err.details) {
      const dot = x.path.indexOf(".");
      if (dot < 0) continue;
      const field = x.path.slice(0, dot) as ParamField;
      const key = x.path.slice(dot + 1);
      if (!Object.hasOwn(fields, field)) continue;
      if (decl[field].some((p) => p.key === key)) fields[field][key] = t("params.invalid");
      else others.push(t("params.invalidKey", { key }));
    }
    setFieldErrors(fields);
    setOtherErrors(others);
  }

  const unsaved = [
    d.model !== saved.model,
    d.fallback !== saved.fallback,
    !sameJson(d.modelParams, saved.modelParams),
    !sameJson(d.fallbackParams, saved.fallbackParams),
  ].filter(Boolean).length;

  async function onSave() {
    if (save.pending || noModels) return;
    const main = decodeModel(d.model);
    if (main === null) return;
    const fb = decodeModel(d.fallback);
    setFieldErrors(NO_FIELD_ERRORS);
    setOtherErrors([]);
    const r = await save.send({
      ...savedDefinition(agent),
      model: main,
      fallback: fb,
      modelParams: d.modelParams,
      fallbackParams: fb === null ? {} : d.fallbackParams,
    });
    if (r.saved) draft.reset();
    else showDetails(r.error);
  }

  function discard() {
    draft.reset();
    save.clear();
    setFieldErrors(NO_FIELD_ERRORS);
    setOtherErrors([]);
  }

  const errors =
    Object.keys(fieldErrors.modelParams).length +
    Object.keys(fieldErrors.fallbackParams).length +
    otherErrors.length +
    (save.error ? 1 : 0);
  return (
    <AgentSectionFrame
      dirty={draft.dirty}
      actionRow={actionRow({
        unsaved,
        errors,
        pending: save.pending,
        onDiscard: discard,
        onSave: () => void onSave(),
        disabled: noModels,
      })}
    >
      <Stack gap={16}>
        <SaveFeedback save={save} onReload={() => void save.reload(discard)} extra={otherErrors} />
        <div>
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
                disabled={noModels || save.pending}
                value={d.model}
                onChange={(e) => {
                  const v = e.target.value;
                  edit((cur) => ({
                    ...cur,
                    model: v,
                    modelParams: keepDeclared(declOf(v), cur.modelParams),
                  }));
                  setFieldErrors((x) => ({ ...x, modelParams: {} }));
                }}
                options={options}
              />
            </Field>
            <Field label={t("form.fallbackLabel")} optional>
              <Select
                name="fallback"
                disabled={save.pending}
                value={d.fallback}
                onChange={(e) => {
                  const v = e.target.value;
                  // without a fallback its params must be empty (the kernel refuses them)
                  edit((cur) => ({
                    ...cur,
                    fallback: v,
                    fallbackParams: v === "" ? {} : keepDeclared(declOf(v), cur.fallbackParams),
                  }));
                  setFieldErrors((x) => ({ ...x, fallbackParams: {} }));
                }}
                options={[{ value: "", label: t("form.fallbackNone") }, ...options]}
              />
            </Field>
            {[...hints].map((w) => (
              <Callout key={w} tone="warn">
                {t.has(`warnings.${w}`) ? t(`warnings.${w}`) : t("warnings.unknown", { code: w })}
              </Callout>
            ))}
          </FormSection>
          {modelDecl.length > 0 && (
            <FormSection
              id="params"
              title={t("form.modelParamsTitle")}
              description={t("form.paramsSectionHint")}
            >
              <ModelParams
                parameters={modelDecl}
                value={d.modelParams}
                onChange={(modelParams) => edit((cur) => ({ ...cur, modelParams }))}
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
                value={d.fallbackParams}
                onChange={(fallbackParams) => edit((cur) => ({ ...cur, fallbackParams }))}
                locale={locale}
                errors={fieldErrors.fallbackParams}
              />
            </FormSection>
          )}
        </div>
      </Stack>
    </AgentSectionFrame>
  );
}
