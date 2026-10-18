import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useState,
} from "react";
import { useDesignT } from "../provider";
import type { ControlA11y } from "./a11y";

export function Input({
  prefix,
  suffix,
  invalid,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> & {
  prefix?: ReactNode;
  suffix?: ReactNode;
  invalid?: boolean;
}) {
  return (
    <div
      className="cb-input"
      data-state={
        rest.disabled ? "disabled" : invalid || rest["aria-invalid"] ? "error" : undefined
      }
    >
      {prefix ? <span className="cb-input-affix">{prefix}</span> : null}
      <input {...rest} aria-invalid={invalid ? true : rest["aria-invalid"]} />
      {suffix ? <span className="cb-input-affix">{suffix}</span> : null}
    </div>
  );
}

function lineCount(v: unknown): number {
  return String(v ?? "").split("\n").length;
}

export function Textarea({
  code,
  onChange,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { code?: boolean }) {
  const [lines, setLines] = useState(() => lineCount(rest.value ?? rest.defaultValue));
  const shown = code && rest.value !== undefined ? lineCount(rest.value) : lines;
  return (
    <div
      className="cb-textarea"
      data-state={rest.disabled ? "disabled" : rest["aria-invalid"] ? "error" : undefined}
    >
      {code ? (
        <div className="cb-textarea-gutter" data-code="true" aria-hidden="true">
          {Array.from({ length: shown }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行号按位置稳定
            <span key={i}>{i + 1}</span>
          ))}
        </div>
      ) : null}
      <textarea
        {...rest}
        data-code={code ? "true" : undefined}
        onChange={(e) => {
          setLines(lineCount(e.target.value));
          onChange?.(e);
        }}
      />
    </div>
  );
}

export function Select({
  options,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <div
      className="cb-select"
      data-state={rest.disabled ? "disabled" : rest["aria-invalid"] ? "error" : undefined}
    >
      <select {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="cb-input-affix" aria-hidden="true">
        ▾
      </span>
    </div>
  );
}

export function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  disabled,
  ...a11y
}: ControlA11y & {
  disabled?: boolean;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (n: number) => void;
  label: string;
}) {
  const t = useDesignT();
  const clamp = (n: number) =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));
  const decimals = (String(step).split(".")[1] ?? "").length;
  const bump = (d: number) => onChange(clamp(Number((value + d * step).toFixed(decimals))));
  return (
    <div className="cb-stepper" data-state={disabled ? "disabled" : undefined}>
      <button
        type="button"
        className="cb-stepper-btn"
        aria-label={t("stepper.decrease")}
        onClick={() => bump(-1)}
        disabled={disabled || (min !== undefined && value <= min)}
      >
        −
      </button>
      <input
        {...a11y}
        type="number"
        aria-label={label}
        disabled={disabled}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) onChange(clamp(n));
        }}
      />
      <button
        type="button"
        className="cb-stepper-btn"
        aria-label={t("stepper.increase")}
        onClick={() => bump(1)}
        disabled={disabled || (max !== undefined && value >= max)}
      >
        +
      </button>
    </div>
  );
}
