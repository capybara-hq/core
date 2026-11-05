"use client";

import {
  type ActionRowProps,
  Card,
  Field,
  Select,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { findModel, keepDeclared, type ParamValue, type ProviderModels } from "../lib/agents";
import { labelLocale, modelLabel } from "../lib/extension-label";
import {
  decodeModel,
  encodeModel,
  type PurposeTarget,
  type PurposeView,
  targetIssues,
  targetName,
} from "../lib/models";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";
import { ModelParams } from "./ModelParams";

type Params = Record<string, ParamValue>;

/** One purpose's draft: the encoded model (`""` = unset / use the deployment default) and its params. */
export interface PurposeDraft {
  model: string;
  params: Params;
}

/** A purpose's save error: a message, extra lines, and the fields it lands on. */
interface PurposeError {
  message?: string;
  extra: string[];
  model?: boolean;
  params: Record<string, string>;
}

type Scope = "deployment" | "org";

/** Parameter equality (key order does not matter). */
const sameParams = (a: Params, b: Params) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && b[k] === v);

const savedOf = (view: PurposeView, scope: Scope) =>
  scope === "deployment" ? view.default : view.override;

const savedDraft = (view: PurposeView, scope: Scope): PurposeDraft => {
  const saved = savedOf(view, scope);
  return { model: saved === null ? "" : encodeModel(saved.model), params: saved?.params ?? {} };
};

const sameDraft = (a: PurposeDraft, b: PurposeDraft) =>
  a.model === b.model && sameParams(a.params, b.params);

/**
 * The drafts of a page of purpose cards and the page's one ActionRow (spec §4.4): every card edits
 * its draft, the row counts the changed purposes and saves them all (one PUT per changed purpose;
 * the unset / default option writes `null`, which clears the deployment default or restores the
 * org's default). A purpose that fails keeps its draft and shows its error in its card.
 */
export function usePurposeDrafts({
  purposes,
  providers,
  scope,
  save,
  onSaved,
}: {
  purposes: PurposeView[];
  providers: ProviderModels[];
  scope: Scope;
  save(purpose: string, target: PurposeTarget | null): Promise<PurposeView>;
  onSaved(view: PurposeView): void;
}) {
  const t = useTranslations("models.purpose");
  const tp = useTranslations("agents.params");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [edits, setEdits] = useState<Record<string, PurposeDraft>>({});
  const [errors, setErrors] = useState<Record<string, PurposeError>>({});
  const [busy, setBusy] = useState(false);

  const draftOf = (v: PurposeView) => edits[v.purpose] ?? savedDraft(v, scope);
  const changed = purposes.filter((v) => !sameDraft(draftOf(v), savedDraft(v, scope)));
  const errorCount = changed.filter((v) => errors[v.purpose] !== undefined).length;

  const setDraft = (purpose: string, d: PurposeDraft) => {
    setEdits((e) => ({ ...e, [purpose]: d }));
    setErrors(({ [purpose]: _, ...rest }) => rest);
  };

  async function saveOne(v: PurposeView): Promise<boolean> {
    const d = draftOf(v);
    const ref = decodeModel(d.model);
    try {
      onSaved(await save(v.purpose, ref === null ? null : { model: ref, params: d.params }));
      setEdits(({ [v.purpose]: _, ...rest }) => rest);
      return true;
    } catch (e) {
      const decl = ref === null ? [] : (findModel(providers, ref)?.parameters ?? []);
      const issues = targetIssues(e, decl);
      let err: PurposeError;
      if (issues === null) err = { message: errorMessage(e), extra: [], params: {} };
      else {
        const extra = [
          ...issues.unknownParams.map((key) => tp("invalidKey", { key })),
          ...issues.other,
        ];
        const onFields = issues.model || issues.params.length > 0;
        err = {
          extra,
          model: issues.model,
          params: Object.fromEntries(issues.params.map((k) => [k, tp("invalid")])),
          // When every detail landed on a field, the summary is not repeated
          ...(onFields && extra.length === 0 ? {} : { message: errorMessage(e) }),
        };
      }
      setErrors((x) => ({ ...x, [v.purpose]: err }));
      return false;
    }
  }

  async function saveAll() {
    setBusy(true);
    try {
      const results = await Promise.all(changed.map(saveOne));
      if (results.every(Boolean)) toast.success(t("savedAll", { n: results.length }));
    } finally {
      setBusy(false);
    }
  }

  const actionRow: ActionRowProps | undefined =
    changed.length === 0
      ? undefined
      : {
          unsaved: changed.length,
          errors: errorCount,
          cancel: {
            label: tc("cancel"),
            onSelect: () => {
              setEdits({});
              setErrors({});
            },
          },
          primary: { label: t("save"), onSelect: () => void saveAll(), loading: busy },
        };

  const editor = (v: PurposeView) => (
    <PurposeEditor
      key={v.purpose}
      view={v}
      providers={providers}
      scope={scope}
      draft={draftOf(v)}
      onDraft={(d) => setDraft(v.purpose, d)}
      disabled={busy}
      {...(errors[v.purpose] !== undefined ? { error: errors[v.purpose] } : {})}
    />
  );

  return { editor, actionRow };
}

/**
 * One model purpose's card (shared by the deployment defaults and the org overrides):
 * - `scope: "deployment"`: edits the deployment default (`view.default`); 「未设置」 clears it;
 * - `scope: "org"`: shows the deployment default and edits the org's override (`view.override`);
 *   「使用部署默认」 restores the default.
 * A chosen model renders its parameter declarations (ModelParams; switching models keeps the
 * parameters that are still valid, keepDeclared). A plugin purpose notes that plugins cannot call
 * models yet. The card has no save of its own: the page's ActionRow saves (usePurposeDrafts).
 */
function PurposeEditor({
  view,
  providers,
  scope,
  draft,
  onDraft,
  disabled,
  error,
}: {
  view: PurposeView;
  providers: ProviderModels[];
  scope: Scope;
  draft: PurposeDraft;
  onDraft(d: PurposeDraft): void;
  disabled: boolean;
  error?: PurposeError;
}) {
  const t = useTranslations("models.purpose");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const saved = savedOf(view, scope);
  const ref = decodeModel(draft.model);
  const decl = ref === null ? [] : (findModel(providers, ref)?.parameters ?? []);
  const label = (view.label as Record<string, string | undefined>)[locale] || view.label.en;
  const plugin = view.declaredBy !== "kernel";

  const options = [
    { value: "", label: scope === "deployment" ? t("unset") : t("useDefault") },
    ...providers.flatMap((p) =>
      p.models.map((m) => ({
        value: encodeModel({ provider: p.provider, model: m.id }),
        label: modelLabel({ name: p.provider, displayName: p.displayName }, m.displayName, lang),
      })),
    ),
  ];
  // A saved model that is not listed (its provider failed, the model is gone): still listed, marked
  if (saved !== null && !options.some((o) => o.value === encodeModel(saved.model))) {
    options.push({
      value: encodeModel(saved.model),
      label: t("unavailable", { target: targetName(providers, saved.model, lang) }),
    });
  }

  const defaultText =
    view.default === null ? t("unset") : targetName(providers, view.default.model, lang);

  return (
    <div data-purpose={view.purpose}>
      <Card
        title={
          <Stack direction="row" gap={8} align="center">
            <Text>{label}</Text>
            {/* The purpose id is plain metadata: mono muted text, not a badge */}
            <Text variant="small" tone="muted">
              {view.purpose}
            </Text>
            {/* A state, not a call to act: muted text, never the accent */}
            {scope === "org" && view.override !== null ? (
              <Text variant="small" tone="muted">
                {t("overridden")}
              </Text>
            ) : null}
          </Stack>
        }
      >
        <Stack gap={12}>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {plugin ? t("declaredByPlugin", { plugin: view.declaredBy }) : t("declaredByKernel")}
            </Text>
            {plugin ? (
              <Text variant="small" tone="warn">
                {t("pluginNote")}
              </Text>
            ) : null}
            {scope === "org" ? (
              <Text variant="small">{t("deploymentDefault", { target: defaultText })}</Text>
            ) : null}
            {view.purpose.startsWith("subagent_") ? (
              <Text variant="small" tone="muted">
                {t("subagentHint")}
              </Text>
            ) : null}
          </Stack>
          <Field
            label={t("model")}
            {...(error?.model === true ? { error: t("modelInvalid") } : {})}
          >
            <Select
              value={draft.model}
              disabled={disabled}
              onChange={(e) => {
                const v = e.target.value;
                const r = decodeModel(v);
                onDraft({
                  model: v,
                  params:
                    r === null
                      ? {}
                      : keepDeclared(findModel(providers, r)?.parameters ?? [], draft.params),
                });
              }}
              options={options}
            />
          </Field>
          {decl.length > 0 ? (
            <Stack gap={12}>
              <Text variant="small" tone="muted">
                {t("params")}
              </Text>
              <ModelParams
                parameters={decl}
                value={draft.params}
                onChange={(params) => onDraft({ model: draft.model, params })}
                locale={locale}
                errors={error?.params ?? {}}
              />
            </Stack>
          ) : null}
          {error?.message !== undefined ? (
            <FormError message={error.message} extra={error.extra} />
          ) : null}
        </Stack>
      </Card>
    </div>
  );
}
