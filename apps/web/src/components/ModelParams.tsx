"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useId } from "react";
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
 * 按模型的参数声明渲染参数控件。只有用户改动过的键进入 `value`（未改动的由内核补默认值），
 * 控件在未改动时显示声明的默认值。
 * - 标准旋钮：`effort` / `thinking` 用分段按钮（按声明顺序），`temperature` 用滑块加数字框，
 *   `maxOutputTokens` 用数字框；
 * - 厂商专有参数按 schema：枚举 → 下拉框，布尔 → 开关，上下限齐全的数字 → 滑块，其余 → 输入框。
 * `errors` 以参数键为 key，错误文案显示在对应控件旁。
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
  const id = useId();

  /** 设置一个键；`undefined` 表示回到未设置（不提交）。 */
  const set = (key: string, v: ParamValue | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  return parameters.map((p, i) => {
    const pid = `${id}-${i}`;
    const label = text(p.label, locale);
    const current = Object.hasOwn(value, p.key) ? value[p.key] : p.default;
    const error = errors[p.key];
    const describedBy =
      [p.description && `${pid}-desc`, error !== undefined && `${pid}-err`]
        .filter(Boolean)
        .join(" ") || undefined;
    const aria = {
      "aria-invalid": error !== undefined ? true : undefined,
      "aria-describedby": describedBy,
    } as const;
    const s = p.schema as { type?: unknown; enum?: unknown; minimum?: number; maximum?: number };
    const enumValues = s.type === "string" && Array.isArray(s.enum) ? (s.enum as string[]) : null;
    const isNumber = s.type === "number" || s.type === "integer";
    const step = s.type === "integer" ? 1 : "any";
    const segmented = (p.standard === "effort" || p.standard === "thinking") && enumValues !== null;
    /** 用户是否设置过该键（未设置的不提交，由内核补默认值）。 */
    const isSet = Object.hasOwn(value, p.key);
    const defaultText =
      p.default === undefined ? t("default") : t("defaultValue", { value: String(p.default) });
    /** 滑块的位置：已设置或有默认值时取该值；都没有时放在中点，不冒充某个具体取值。 */
    const thumb = (min: number, max: number) =>
      typeof current === "number" ? current : (min + max) / 2;
    /** 「恢复默认」按钮：开关与滑块设置过之后显示，点击删除该键。 */
    const reset = isSet && (
      <button
        type="button"
        className="secondary"
        aria-label={t("resetLabel", { label })}
        onClick={() => set(p.key, undefined)}
      >
        {t("reset")}
      </button>
    );

    let control: ReactNode;
    if (segmented) {
      const knob = p.standard;
      control = (
        <fieldset
          className="segmented"
          aria-labelledby={`${pid}-label`}
          aria-describedby={describedBy}
        >
          {/* 首段「默认」：按下表示未设置（参数都是可选的） */}
          <button
            type="button"
            className={isSet ? "secondary" : undefined}
            aria-pressed={!isSet}
            aria-invalid={aria["aria-invalid"]}
            onClick={() => set(p.key, undefined)}
          >
            {p.default === undefined
              ? t("default")
              : t("defaultValue", {
                  value: t.has(`${knob}.${p.default}`)
                    ? t(`${knob}.${p.default}`)
                    : String(p.default),
                })}
          </button>
          {(enumValues ?? []).map((v) => {
            const pressed = isSet && value[p.key] === v;
            return (
              <button
                key={v}
                type="button"
                className={pressed ? undefined : "secondary"}
                aria-pressed={pressed}
                aria-invalid={aria["aria-invalid"]}
                onClick={() => set(p.key, v)}
              >
                {t.has(`${knob}.${v}`) ? t(`${knob}.${v}`) : v}
              </button>
            );
          })}
        </fieldset>
      );
    } else if (p.standard === "temperature" && isNumber) {
      const min = s.minimum ?? 0;
      const max = s.maximum ?? 2;
      control = (
        <div className="row">
          <input
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={0.01}
            value={thumb(min, max)}
            onChange={(e) => set(p.key, toNumber(e.target.value))}
            {...aria}
          />
          <input
            id={pid}
            type="number"
            min={min}
            max={max}
            step="any"
            placeholder={defaultText}
            value={isSet && typeof value[p.key] === "number" ? Number(value[p.key]) : ""}
            onChange={(e) => set(p.key, toNumber(e.target.value))}
            {...aria}
          />
          {reset}
        </div>
      );
    } else if (enumValues) {
      control = (
        <select
          id={pid}
          value={typeof value[p.key] === "string" ? String(value[p.key]) : ""}
          onChange={(e) => set(p.key, e.target.value === "" ? undefined : e.target.value)}
          {...aria}
        >
          <option value="">{defaultText}</option>
          {enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    } else if (s.type === "boolean") {
      control = (
        <div className="row">
          <input
            id={pid}
            type="checkbox"
            role="switch"
            checked={current === true}
            aria-checked={current === true}
            onChange={(e) => set(p.key, e.target.checked)}
            {...aria}
          />
          {!isSet && <span className="muted">{defaultText}</span>}
          {reset}
        </div>
      );
    } else if (
      p.standard !== "maxOutputTokens" &&
      isNumber &&
      s.minimum !== undefined &&
      s.maximum !== undefined
    ) {
      control = (
        <div className="row">
          <input
            id={pid}
            type="range"
            min={s.minimum}
            max={s.maximum}
            step={s.type === "integer" ? 1 : (s.maximum - s.minimum) / 100}
            value={thumb(s.minimum, s.maximum)}
            onChange={(e) => set(p.key, toNumber(e.target.value))}
            {...aria}
          />
          <output htmlFor={pid}>{isSet ? String(value[p.key]) : defaultText}</output>
          {reset}
        </div>
      );
    } else if (isNumber) {
      control = (
        <input
          id={pid}
          type="number"
          min={s.minimum}
          max={s.maximum}
          step={step}
          placeholder={p.default === undefined ? undefined : String(p.default)}
          value={typeof value[p.key] === "number" ? Number(value[p.key]) : ""}
          onChange={(e) => set(p.key, toNumber(e.target.value))}
          {...aria}
        />
      );
    } else {
      // 不带枚举的字符串，以及子集之外的 schema：文本框
      const maxLength = (p.schema as { maxLength?: number }).maxLength;
      control = (
        <input
          id={pid}
          type="text"
          maxLength={maxLength}
          placeholder={p.default === undefined ? undefined : String(p.default)}
          value={typeof value[p.key] === "string" ? String(value[p.key]) : ""}
          onChange={(e) => set(p.key, e.target.value === "" ? undefined : e.target.value)}
          {...aria}
        />
      );
    }

    // 分段按钮由 fieldset 的 aria-labelledby 命名，其余控件用 label[for]（温度滑块另带 aria-label）
    return (
      <div key={p.key} className="param" data-param={p.key}>
        {segmented ? (
          <span id={`${pid}-label`}>{label}</span>
        ) : (
          <label id={`${pid}-label`} htmlFor={pid}>
            {label}
          </label>
        )}
        {control}
        {p.description && <small id={`${pid}-desc`}>{text(p.description, locale)}</small>}
        {error !== undefined && (
          <p id={`${pid}-err`} className="error">
            {error}
          </p>
        )}
      </div>
    );
  });
}
