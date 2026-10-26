import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useRef,
  useState,
} from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import type { ControlA11y } from "./a11y";
import { type Density, useDensity } from "./density";
import { useNumberDraft } from "./number-draft";
import { stepDecimals } from "./step";

export function Input({
  prefix,
  suffix,
  invalid,
  density,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> & {
  prefix?: ReactNode;
  suffix?: ReactNode;
  invalid?: boolean;
  density?: Density;
}) {
  const step = useDensity(density);
  return (
    <div
      className="cb-input"
      data-part="input"
      data-density={step}
      data-state={
        rest.disabled ? "disabled" : invalid || rest["aria-invalid"] ? "error" : undefined
      }
    >
      {prefix ? <span className="cb-input-affix">{prefix}</span> : null}
      <input
        {...rest}
        data-part="input-control"
        aria-invalid={invalid ? true : rest["aria-invalid"]}
      />
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
  onScroll,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { code?: boolean }) {
  const [lines, setLines] = useState(() => lineCount(rest.value ?? rest.defaultValue));
  const shown = code && rest.value !== undefined ? lineCount(rest.value) : lines;
  const gutterLines = useRef<HTMLDivElement>(null);
  return (
    <div
      className="cb-textarea"
      data-part="textarea"
      data-state={rest.disabled ? "disabled" : rest["aria-invalid"] ? "error" : undefined}
    >
      {code ? (
        // 行号栏不撑高输入框：占位元素只决定栏宽，行号绝对定位并随 textarea 的 scrollTop 平移
        <div className="cb-textarea-gutter" data-code="true" aria-hidden="true">
          <span className="cb-textarea-gutter-size">{shown}</span>
          <div className="cb-textarea-gutter-lines" ref={gutterLines}>
            {Array.from({ length: shown }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行号按位置稳定
              <span key={i}>{i + 1}</span>
            ))}
          </div>
        </div>
      ) : null}
      <textarea
        {...rest}
        data-code={code ? "true" : undefined}
        onChange={(e) => {
          setLines(lineCount(e.target.value));
          onChange?.(e);
        }}
        onScroll={(e) => {
          if (gutterLines.current) {
            gutterLines.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`;
          }
          onScroll?.(e);
        }}
      />
    </div>
  );
}

export function Select({
  options,
  density,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  options: { value: string; label: string }[];
  density?: Density;
}) {
  const step = useDensity(density);
  return (
    <div
      className="cb-select"
      data-part="select"
      data-density={step}
      data-state={rest.disabled ? "disabled" : rest["aria-invalid"] ? "error" : undefined}
    >
      <select {...rest} data-part="input-control">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="cb-input-affix" aria-hidden="true">
        <Icon name="chevron-down" size={14} />
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
  const decimals = stepDecimals(step);
  const bump = (d: number) => onChange(clamp(Number((value + d * step).toFixed(decimals))));
  const draft = useNumberDraft({
    value,
    min,
    max,
    normalize: (n) => clamp(Number(n.toFixed(decimals))),
    onCommit: onChange,
  });
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
        min={min}
        max={max}
        step={step}
        {...draft}
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
