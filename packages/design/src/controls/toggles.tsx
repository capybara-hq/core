import { type ReactNode, useEffect, useId, useRef } from "react";
import type { ControlA11y } from "./a11y.js";

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  ...a11y
}: ControlA11y & {
  checked: boolean | "indeterminate";
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const mixed = checked === "indeterminate";
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  const state = mixed ? "mixed" : checked ? "checked" : "unchecked";
  return (
    <label className="cb-check" data-state={state} data-disabled={disabled ? "true" : undefined}>
      <input
        {...a11y}
        ref={ref}
        type="checkbox"
        checked={checked === true}
        aria-checked={mixed ? "mixed" : checked}
        disabled={disabled}
        onChange={() => onChange(mixed ? true : !checked)}
      />
      <span className="cb-box" aria-hidden="true">
        {mixed ? "–" : checked ? "✓" : ""}
      </span>
      {label ? <span className="cb-check-label">{label}</span> : null}
    </label>
  );
}

export function RadioGroup({
  value,
  onChange,
  options,
  variant = "plain",
  label,
  disabled,
  ...a11y
}: ControlA11y & {
  disabled?: boolean;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: ReactNode; description?: ReactNode }[];
  variant?: "plain" | "card";
  label: string;
}) {
  const name = useId();
  return (
    <div
      {...a11y}
      className="cb-radios"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled ? true : undefined}
      data-variant={variant}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className="cb-radio"
          data-variant={variant}
          data-state={o.value === value ? "checked" : "unchecked"}
          data-disabled={disabled ? "true" : undefined}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          <span className="cb-box" aria-hidden="true" />
          <span className="cb-radio-text">
            <span className="cb-radio-label">{o.label}</span>
            {o.description ? <span className="cb-radio-desc">{o.description}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  ...a11y
}: ControlA11y & {
  disabled?: boolean;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      {...a11y}
      type="button"
      role="switch"
      disabled={disabled}
      aria-checked={checked}
      aria-label={label}
      className="cb-switch"
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => onChange(!checked)}
    >
      <span className="cb-switch-thumb" aria-hidden="true" />
    </button>
  );
}
