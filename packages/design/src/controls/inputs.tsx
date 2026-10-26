import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
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

/**
 * A plain textarea (spec §6.2, the signed reference): no line-number gutter, no resize grip.
 * `code` keeps lines unwrapped in the mono font, for prompts and JSON.
 */
export function Textarea({
  code,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { code?: boolean }) {
  return (
    <div
      className="cb-textarea"
      data-part="textarea"
      data-state={rest.disabled ? "disabled" : rest["aria-invalid"] ? "error" : undefined}
    >
      <textarea {...rest} data-code={code ? "true" : undefined} />
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
