"use client";

import {
  Checkbox,
  Field,
  Input,
  QuestionBlock,
  type QuestionField,
  type QuestionState,
  RadioGroup,
  Slider,
  Stack,
  Switch,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactElement, useState } from "react";
import type { FormAnswer, InputForm } from "../lib/conversations";
import {
  answerQuestion,
  answerText,
  enumValues,
  type FormDraft,
  fieldKind,
  formText,
  OTHER,
} from "../lib/questions";
import type { QuestionItem } from "../lib/timeline";
import { useErrorMessage } from "../lib/use-error-message";
import { useSession } from "./shell/session";

type FormField = InputForm["fields"][number];

/** 输入框的数字：空串或非有限数视为未填。 */
function toNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 通用 `InputForm` 渲染器（`ask_user`、插件工具与 MCP elicitation 共用）：
 * 枚举 → RadioGroup（单选）/ Checkbox 组（multiSelect），`allowOther` → 追加「其他」+ Input；
 * 布尔 → Switch；上下限齐全的数字 → Slider（带数值框），其余数字 → 数字 Input；字符串 → Input。
 * 文案取 `label[locale]`，回退 en；纯字符串原样。`missing` 中的字段显示「必填」错误。
 */
export function InputFormFields({
  form,
  draft,
  onChange,
  missing = [],
  disabled,
}: {
  form: InputForm;
  draft: FormDraft;
  onChange(next: FormDraft): void;
  missing?: string[];
  disabled?: boolean;
}) {
  const t = useTranslations("question");
  const locale = useLocale();
  const setValue = (key: string, v: FormDraft["values"][string]) =>
    onChange({ ...draft, values: { ...draft.values, [key]: v } });
  const setOther = (key: string, text: string) =>
    onChange({ ...draft, other: { ...draft.other, [key]: text } });

  return form.fields.map((f: FormField) => {
    const label = formText(f.label, locale);
    const v = draft.values[f.key];
    const other = draft.other[f.key] ?? "";
    const otherInput = (
      <Input
        aria-label={t("otherLabel", { field: label })}
        placeholder={t("otherPlaceholder")}
        value={other}
        disabled={disabled}
        onChange={(e) => setOther(f.key, e.target.value)}
      />
    );
    let control: ReactElement<Record<string, unknown>>;
    let extra: ReactElement | null = null;
    switch (fieldKind(f)) {
      case "enum": {
        const options = enumValues(f).map((o) => ({ value: o, label: o }));
        if (f.allowOther) options.push({ value: OTHER, label: t("other") });
        control = (
          <RadioGroup
            label={label}
            value={typeof v === "string" ? v : ""}
            onChange={(next) => setValue(f.key, next)}
            options={options}
            {...(disabled ? { disabled } : {})}
          />
        );
        if (v === OTHER) extra = otherInput;
        break;
      }
      case "multi": {
        const picked = Array.isArray(v) ? v : [];
        const toggle = (o: string, on: boolean) =>
          setValue(f.key, on ? [...picked, o] : picked.filter((x) => x !== o));
        const opts = [
          ...enumValues(f).map((o) => ({ value: o, label: o })),
          ...(f.allowOther ? [{ value: OTHER, label: t("other") }] : []),
        ];
        control = (
          // biome-ignore lint/a11y/useSemanticElements: fieldset 带浏览器默认边框与内边距，apps/web 不能写样式；用 role=group 分组
          <div role="group" aria-label={label}>
            <Stack gap={4}>
              {opts.map((o) => (
                <Checkbox
                  key={o.value}
                  label={o.label}
                  checked={picked.includes(o.value)}
                  onChange={(on) => toggle(o.value, on)}
                  {...(disabled ? { disabled } : {})}
                />
              ))}
            </Stack>
          </div>
        );
        if (picked.includes(OTHER)) extra = otherInput;
        break;
      }
      case "boolean":
        control = (
          <Switch
            label={label}
            checked={v === true}
            onChange={(on) => setValue(f.key, on)}
            {...(disabled ? { disabled } : {})}
          />
        );
        break;
      case "number": {
        const s = f.schema as { type?: string; minimum?: number; maximum?: number };
        const integer = s.type === "integer";
        control =
          typeof s.minimum === "number" && typeof s.maximum === "number" ? (
            <Slider
              label={label}
              min={s.minimum}
              max={s.maximum}
              step={integer ? 1 : Number(((s.maximum - s.minimum) / 100).toPrecision(1)) || 0.01}
              value={typeof v === "number" ? v : undefined}
              withInput
              onChange={(n) => setValue(f.key, n)}
              {...(disabled ? { disabled } : {})}
            />
          ) : (
            <Input
              type="number"
              min={s.minimum}
              max={s.maximum}
              step={integer ? 1 : "any"}
              value={typeof v === "number" ? v : ""}
              disabled={disabled}
              onChange={(e) => setValue(f.key, toNumber(e.target.value))}
            />
          );
        break;
      }
      default: {
        const maxLength = (f.schema as { maxLength?: number }).maxLength;
        control = (
          <Input
            type="text"
            maxLength={maxLength}
            value={typeof v === "string" ? v : ""}
            disabled={disabled}
            onChange={(e) => setValue(f.key, e.target.value)}
          />
        );
      }
    }
    const description = formText(f.description, locale);
    return (
      <div key={f.key} data-field={f.key}>
        <Stack gap={4}>
          <Field
            label={label}
            {...(f.required ? { required: true } : {})}
            {...(description !== "" ? { help: description } : {})}
            {...(missing.includes(f.key) ? { error: t("fieldRequired") } : {})}
          >
            {control}
          </Field>
          {extra}
        </Stack>
      </div>
    );
  });
}

/** Only absolute http(s) addresses (the kernel checks too): `javascript:` and the rest never link. */
export function safeLink(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** An `InputForm` field as the design `QuestionBlock` takes it (localized). */
export function questionField(f: InputForm["fields"][number], locale: string): QuestionField {
  const s = f.schema as {
    type?: string;
    minimum?: number;
    maximum?: number;
    maxLength?: number;
  };
  const kind = fieldKind(f);
  const description = formText(f.description, locale);
  return {
    key: f.key,
    label: formText(f.label, locale),
    kind,
    ...(description !== "" ? { description } : {}),
    ...(kind === "enum" || kind === "multi" ? { options: enumValues(f) } : {}),
    ...(f.allowOther ? { allowOther: true } : {}),
    ...(f.required ? { required: true } : {}),
    ...(s.type === "integer" ? { integer: true } : {}),
    ...(typeof s.minimum === "number" ? { min: s.minimum } : {}),
    ...(typeof s.maximum === "number" ? { max: s.maximum } : {}),
    ...(typeof s.maxLength === "number" ? { maxLength: s.maxLength } : {}),
  };
}

/**
 * A question in the conversation (`ask_user`, an extension's tool, MCP elicitation; design
 * `QuestionBlock`): options plus Other, a URL shown in full and opened in a new window, Answer.
 * Answered, one question / answer line; expired or cancelled, its line.
 */
export function QuestionCard({ orgId, item }: { orgId: string; item: QuestionItem }) {
  const t = useTranslations("question");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<FormAnswer | null>(null);
  const done = item.answered;
  const fields = item.form.fields.map((f) => questionField(f, locale));
  const title = formText(item.form.title, locale) || t("title");
  const pairs = (answer: Record<string, unknown>): [string, string][] =>
    item.form.fields
      .filter((f) => Object.hasOwn(answer, f.key))
      .map((f) => [
        formText(f.label, locale),
        answerText(
          answer[f.key] as FormAnswer[string],
          { yes: t("yes"), no: t("no") },
          t("separator"),
        ),
      ]);
  const who = (id: string | null | undefined) =>
    id === null || id === undefined ? undefined : id === me.account.id ? t("you") : id;

  let state: QuestionState;
  if (done !== null) {
    const w = who(done.byAccountId);
    state =
      done.outcome === "answered"
        ? { kind: "answered", pairs: pairs(done.answer ?? {}), ...(w ? { who: w } : {}) }
        : done.outcome === "expired"
          ? { kind: "expired" }
          : { kind: "skipped" };
  } else if (submitted !== null) {
    state = { kind: "answered", pairs: pairs(submitted), who: t("you") };
  } else {
    state = { kind: "pending", busy: pending };
  }

  async function answer(a: FormAnswer) {
    setPending(true);
    try {
      await answerQuestion(orgId, item.questionId, a);
      setSubmitted(a);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const link = safeLink(item.form.url);
  return (
    <div data-role="question" data-question-id={item.questionId}>
      <QuestionBlock
        title={title}
        {...(link !== undefined ? { url: link } : {})}
        fields={fields}
        state={state}
        onAnswer={(a) => void answer(a as FormAnswer)}
      />
    </div>
  );
}
