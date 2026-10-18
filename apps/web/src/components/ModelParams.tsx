"use client";

import { Field, Input, Segmented, Select, Slider, Switch } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import type { ModelParameter, ParamValue } from "../lib/agents";

type Params = Record<string, ParamValue>;

/** 插件提供的 `{ zh, en }` 文案：取当前语言，缺失时回退到 en。 */
function text(t: { zh: string; en: string }, locale: string): string {
  return (t as Record<string, string | undefined>)[locale] || t.en;
}

/** 输入框的数字：空串或非有限数视为未设置。 */
function toNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 滑块步长：整数为 1；否则约百分之一的范围，取 10 的整数次幂（如 0..2 → 0.01）。
 * 小数位数按 `ceil(-log10(raw))` 推出并限制在 0..10，再由 toFixed 得到不含浮点误差的步长
 * （极小的范围如 0..1e-6 得到 1e-8，而不是被指数写法误判为整数步长）。
 */
function sliderStep(min: number, max: number, integer: boolean): number {
  if (integer) return 1;
  const raw = (max - min) / 100;
  if (!(raw > 0) || !Number.isFinite(raw)) return 0.01;
  if (raw >= 1) return 10 ** Math.floor(Math.log10(raw));
  const decimals = Math.min(10, Math.max(0, Math.ceil(-Math.log10(raw) - 1e-9)));
  return Number((10 ** -decimals).toFixed(decimals));
}

/**
 * 按模型的参数声明渲染参数控件（设计系统的 Field + 控件）。只有用户改动过的键进入 `value`
 * （未改动的由内核补默认值）；改动过的字段在标签行右侧出现「恢复默认」（Field onReset）。
 * - 标准旋钮：`effort` / `thinking` 用 Segmented（首段「默认」，其余按声明顺序），
 *   `temperature` 用带数值框的 Slider，`maxOutputTokens` 用数字输入框；
 * - 厂商专有参数按 schema：枚举 → Select，布尔 → Switch，上下限齐全的数字 → Slider，其余 → Input。
 * 未设置的滑块不冒充某个取值（拇指居中，数值框以占位显示默认值，spec §6.2）。
 * `errors` 以参数键为 key，显示为对应 Field 的错误。
 */
export function ModelParams({
  parameters,
  value,
  onChange,
  locale,
  errors = {},
}: {
  parameters: ModelParameter[];
  value: Params;
  onChange: (next: Params) => void;
  locale: string;
  errors?: Record<string, string>;
}) {
  const t = useTranslations("agents.params");

  /** 设置一个键；`undefined` 表示回到未设置（不提交）。 */
  const set = (key: string, v: ParamValue | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  return parameters.map((p) => {
    const label = text(p.label, locale);
    const error = errors[p.key];
    const s = p.schema as { type?: unknown; enum?: unknown; minimum?: number; maximum?: number };
    const enumValues = s.type === "string" && Array.isArray(s.enum) ? (s.enum as string[]) : null;
    const isNumber = s.type === "number" || s.type === "integer";
    /** 用户是否设置过该键（未设置的不提交，由内核补默认值）。 */
    const isSet = Object.hasOwn(value, p.key);
    const own = isSet ? value[p.key] : undefined;
    const defaultText =
      p.default === undefined ? t("default") : t("defaultValue", { value: String(p.default) });

    let control: ReactElement<Record<string, unknown>>;
    if ((p.standard === "effort" || p.standard === "thinking") && enumValues !== null) {
      const knob = p.standard;
      const optionLabel = (v: string) => (t.has(`${knob}.${v}`) ? t(`${knob}.${v}`) : v);
      control = (
        <Segmented
          label={label}
          value={typeof own === "string" ? own : ""}
          onChange={(v) => set(p.key, v === "" ? undefined : v)}
          options={[
            // 首段「默认」：选中表示未设置（参数都是可选的）
            {
              value: "",
              label:
                p.default === undefined
                  ? t("default")
                  : t("defaultValue", { value: optionLabel(String(p.default)) }),
            },
            ...enumValues.map((v) => ({ value: v, label: optionLabel(v) })),
          ]}
        />
      );
    } else if (p.standard === "temperature" && isNumber) {
      const min = s.minimum ?? 0;
      const max = s.maximum ?? 2;
      control = (
        <Slider
          label={label}
          min={min}
          max={max}
          step={sliderStep(min, max, s.type === "integer")}
          value={typeof own === "number" ? own : undefined}
          placeholder={defaultText}
          withInput
          onChange={(n) => set(p.key, n)}
        />
      );
    } else if (enumValues) {
      control = (
        <Select
          value={typeof own === "string" ? own : ""}
          onChange={(e) => set(p.key, e.target.value === "" ? undefined : e.target.value)}
          options={[
            { value: "", label: defaultText },
            ...enumValues.map((v) => ({ value: v, label: v })),
          ]}
        />
      );
    } else if (s.type === "boolean") {
      const current = isSet ? own : p.default;
      control = <Switch label={label} checked={current === true} onChange={(v) => set(p.key, v)} />;
    } else if (
      p.standard !== "maxOutputTokens" &&
      isNumber &&
      s.minimum !== undefined &&
      s.maximum !== undefined
    ) {
      control = (
        <Slider
          label={label}
          min={s.minimum}
          max={s.maximum}
          step={sliderStep(s.minimum, s.maximum, s.type === "integer")}
          value={typeof own === "number" ? own : undefined}
          placeholder={defaultText}
          withInput
          onChange={(n) => set(p.key, n)}
        />
      );
    } else if (isNumber) {
      control = (
        <Input
          type="number"
          min={s.minimum}
          max={s.maximum}
          step={s.type === "integer" ? 1 : "any"}
          placeholder={p.default === undefined ? undefined : String(p.default)}
          value={typeof own === "number" ? own : ""}
          onChange={(e) => set(p.key, toNumber(e.target.value))}
        />
      );
    } else {
      // 不带枚举的字符串，以及子集之外的 schema：文本框
      const maxLength = (p.schema as { maxLength?: number }).maxLength;
      control = (
        <Input
          type="text"
          maxLength={maxLength}
          placeholder={p.default === undefined ? undefined : String(p.default)}
          value={typeof own === "string" ? own : ""}
          onChange={(e) => set(p.key, e.target.value === "" ? undefined : e.target.value)}
        />
      );
    }

    return (
      <div key={p.key} data-param={p.key}>
        <Field
          label={label}
          {...(p.description ? { help: text(p.description, locale) } : {})}
          {...(error !== undefined ? { error } : {})}
          {...(isSet ? { onReset: () => set(p.key, undefined) } : {})}
        >
          {control}
        </Field>
      </div>
    );
  });
}
