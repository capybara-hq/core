"use client";

import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  KeyValue,
  RadioGroup,
  Slider,
  Stack,
  StatusMark,
  Switch,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactElement, useState } from "react";
import type { InputForm } from "../lib/conversations";
import {
  answerQuestion,
  answerText,
  buildAnswer,
  enumValues,
  type FormDraft,
  fieldKind,
  formText,
  initialDraft,
  OTHER,
} from "../lib/questions";
import type { ChatItem } from "../lib/stream";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

type QuestionItem = Extract<ChatItem, { kind: "question" }>;
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

/**
 * 输入请求卡片：标题为表单标题，内容为 {@link InputFormFields}，「提交」调用回答接口；
 * 已回答的显示每个字段的答案，过期 / 取消的显示状态。
 */
export function QuestionCard({ orgId, item }: { orgId: string; item: QuestionItem }) {
  const t = useTranslations("question");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [draft, setDraft] = useState<FormDraft>(() => initialDraft(item.form));
  const [missing, setMissing] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);
  const done = item.answered ?? null;
  const answer = done?.answer ?? submitted;

  async function submit() {
    const built = buildAnswer(item.form, draft);
    setMissing(built.missing);
    if (built.missing.length > 0) return;
    setPending(true);
    setError(undefined);
    try {
      await answerQuestion(orgId, item.questionId, built.answer);
      setSubmitted(built.answer);
    } catch (e) {
      setError(errorMessage(e));
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const status =
    done === null ? (
      submitted === null ? (
        <StatusMark status="waiting" label={t("waiting")} />
      ) : (
        <StatusMark status="success" label={t("outcome.answered")} />
      )
    ) : (
      <StatusMark
        status={done.outcome === "answered" ? "success" : "cancelled"}
        label={t(`outcome.${done.outcome}`)}
      />
    );

  return (
    <div data-role="question" data-question-id={item.questionId}>
      <Card title={formText(item.form.title, locale) || t("title")} actions={status}>
        {answer !== null ? (
          <KeyValue
            keyWidth="12ch"
            rows={item.form.fields.map((f) => ({
              k: formText(f.label, locale),
              v: answerText(
                (answer as Record<string, string | number | boolean | string[]>)[f.key],
                { yes: t("yes"), no: t("no") },
                t("separator"),
              ),
            }))}
          />
        ) : done !== null ? (
          <Text variant="small" tone="muted">
            {t(`outcomeHint.${done.outcome}`)}
          </Text>
        ) : (
          <Stack gap={12}>
            {error !== undefined && <FormError message={error} />}
            <InputFormFields
              form={item.form}
              draft={draft}
              onChange={setDraft}
              missing={missing}
              disabled={pending}
            />
            <Stack direction="row" gap={8}>
              <Button variant="primary" loading={pending} onClick={() => void submit()}>
                {t("submit")}
              </Button>
            </Stack>
          </Stack>
        )}
      </Card>
    </div>
  );
}
