"use client";

import {
  type ActionRowProps,
  Disclosure,
  Field,
  FormSection,
  Select,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  findModel,
  IMAGE_TOOL_PURPOSE,
  keepDeclared,
  type ParamValue,
  type ProviderModels,
} from "../lib/agents";
import { extensionLabel, labelLocale, modelLabel } from "../lib/extension-label";
import {
  decodeModel,
  EVAL_PURPOSE,
  encodeModel,
  type PurposeTarget,
  type PurposeView,
  providersOfKind,
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

/**
 * Each kernel purpose's one muted line: what it is for and what happens while it is unset (the
 * kernel's real fallback: titles and web extraction use the conversation's model, a sub-agent tier
 * the dispatching agent's model, command review asks about a command its rules are unsure about;
 * the eval judge has none, so evals cannot use a judge).
 */
const KERNEL_HINTS: Record<
  string,
  "hint.eval" | "hint.titles" | "hint.webFetch" | "hint.review" | "hint.vision" | "subagentHint"
> = {
  eval: "hint.eval",
  title: "hint.titles",
  review: "hint.review",
  web_fetch: "hint.webFetch",
  vision: "hint.vision",
  subagent_fast: "subagentHint",
  subagent_standard: "subagentHint",
  subagent_capable: "subagentHint",
};

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
 * The drafts of a page of purposes and the page's one ActionRow (spec §4.4): every purpose edits
 * its draft, the ActionRow counts the changed purposes and saves them all (one PUT per changed
 * purpose; the unset / default option writes `null`, which clears the deployment default or
 * restores the org's default). A purpose that fails keeps its draft and shows its error in its box.
 * `sections` draws one FormSection per purpose (spec §5.3 "Model purposes": a purpose is its own
 * box, so the eye finds each one; one box is enough inside it, §1), which the page renders as the
 * template's sibling sections: the template decides stacked or columns from their count.
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

  const sections = purposes.map(editor);

  return { sections, actionRow };
}

/**
 * One model purpose's section (a FormSection; shared by the deployment defaults and the org
 * overrides). The head holds the label, the muted "overridden" mark and the one line under it; the card
 * holds the warnings, the model select and the folded parameters:
 * - `scope: "deployment"`: edits the deployment default (`view.default`); 「未设置」 clears it;
 * - `scope: "org"`: edits the org's override (`view.override`); the default option
 *   「使用部署默认（<model or 未设置>）」 names the deployment default and restores it.
 * A kernel purpose has no source line, only its hint (what it does, what happens while unset); an
 * extension's purpose says 「来自 <extension display name>」. Purpose ids are never shown.
 * A chosen model renders its parameter declarations (ModelParams; switching models keeps the
 * parameters that are still valid, keepDeclared) in a Disclosure, closed by default, whose summary
 * counts the parameters set away from the default; a save that fails on a parameter opens it. A
 * model with no declarations draws no Disclosure. Warnings stay in the card, outside it. The
 * section has no save of its own: the page's ActionRow saves (usePurposeDrafts).
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
  const tm = useTranslations("models");
  const locale = useLocale();
  const lang = labelLocale(locale);
  const saved = savedOf(view, scope);
  const ref = decodeModel(draft.model);
  const decl = ref === null ? [] : (findModel(providers, ref)?.parameters ?? []);
  const label = (view.label as Record<string, string | undefined>)[locale] || view.label.en;
  const plugin = view.declaredBy !== "kernel";
  const hint = plugin ? null : KERNEL_HINTS[view.purpose];

  const defaultText =
    view.default === null ? t("unset") : targetName(providers, view.default.model, lang);

  const options = [
    {
      value: "",
      label: scope === "deployment" ? t("unset") : t("useDefault", { target: defaultText }),
    },
    // Only the models of the purpose's kind (a chat purpose never lists an embedding model)
    ...providersOfKind(providers, view.kind).flatMap((p) =>
      p.models
        .filter((m) => view.requires?.vision !== true || m.capabilities.vision === true)
        .map((m) => ({
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

  // The eval purpose without a model (the deployment default, or what the org ends up with):
  // evals cannot use a judge. A warn line in the eval's box, never folded into its parameters.
  const evalUnmapped =
    view.purpose === EVAL_PURPOSE &&
    (scope === "deployment" ? view.default : view.effective) === null;

  // The image purpose with image models on offer but no target: the tool stays hidden until mapped
  const imageUnmapped =
    view.purpose === IMAGE_TOOL_PURPOSE &&
    (scope === "deployment" ? view.default : view.effective) === null &&
    providersOfKind(providers, "image_generation").some((p) => p.models.length > 0);

  // The parameters fold away; a save that fails on one opens them, so its error is seen
  const [paramsOpen, setParamsOpen] = useState(false);
  useEffect(() => {
    if (error !== undefined && Object.keys(error.params).length > 0) setParamsOpen(true);
  }, [error]);
  const customized = decl.filter((d) => Object.hasOwn(draft.params, d.key)).length;

  const line = plugin
    ? t("declaredByPlugin", {
        plugin: extensionLabel({ name: view.declaredBy, displayName: view.declaredByName }, lang),
      })
    : hint !== undefined && hint !== null
      ? t(hint)
      : undefined;

  return (
    <FormSection
      // The purpose id is an internal identifier: only the anchor, never shown
      id={`purpose-${view.purpose}`}
      title={label}
      // A state, not a call to act: muted text, never the accent
      marks={
        scope === "org" && view.override !== null ? (
          <Text variant="small" tone="muted">
            {t("overridden")}
          </Text>
        ) : undefined
      }
      {...(line !== undefined ? { description: line } : {})}
    >
      <Stack gap={12}>
        {imageUnmapped ? (
          <Text variant="small" tone="warn" icon="circle-alert">
            {tm("imageUnmapped")}
          </Text>
        ) : null}
        {evalUnmapped ? (
          <Text variant="small" tone="warn" icon="circle-alert">
            {tm("evalUnmapped")}
          </Text>
        ) : null}
        <Field label={t("model")} {...(error?.model === true ? { error: t("modelInvalid") } : {})}>
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
          <Disclosure
            summary={
              customized === 0 ? t("paramsAllDefault") : t("paramsCustomized", { n: customized })
            }
            open={paramsOpen}
            onOpenChange={setParamsOpen}
          >
            <Stack gap={12}>
              <ModelParams
                parameters={decl}
                value={draft.params}
                onChange={(params) => onDraft({ model: draft.model, params })}
                locale={locale}
                errors={error?.params ?? {}}
              />
            </Stack>
          </Disclosure>
        ) : null}
        {error?.message !== undefined ? (
          <FormError message={error.message} extra={error.extra} />
        ) : null}
      </Stack>
    </FormSection>
  );
}
