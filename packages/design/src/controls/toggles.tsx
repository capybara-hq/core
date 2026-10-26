import { type ReactNode, useEffect, useId, useRef } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import type { ControlA11y } from "./a11y";

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  tabIndex,
  ...a11y
}: ControlA11y & {
  checked: boolean | "indeterminate";
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** DataTable 行内复选框用：不在当前行时移出 Tab 顺序。 */
  tabIndex?: number;
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
        tabIndex={tabIndex}
        checked={checked === true}
        aria-checked={mixed ? "mixed" : checked}
        disabled={disabled}
        onChange={() => onChange(mixed ? true : !checked)}
      />
      <span className="cb-box" aria-hidden="true">
        {mixed ? "–" : checked ? <Icon name="check" size={12} /> : null}
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
      data-part="switch"
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => onChange(!checked)}
    >
      <span className="cb-switch-thumb" data-part="switch-knob" aria-hidden="true" />
    </button>
  );
}

/**
 * A switch that stands alone (spec §6.3): the switch, its label and its current state as text
 * ("On" / "Off", muted), so the state never relies on color. One `control.default` row.
 */
export function SwitchField({
  label,
  onText,
  offText,
  ...props
}: ControlA11y & {
  disabled?: boolean;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** The state text; default the design i18n "On" / "Off". */
  onText?: string;
  offText?: string;
}) {
  const t = useDesignT();
  const autoId = useId();
  const id = props.id ?? autoId;
  return (
    <span className="cb-switch-field" data-part="switch-field">
      <Switch label={label} {...props} id={id} />
      {/* The switch carries the name (aria-label) and the state (aria-checked); the visible text
          repeats them, so it is hidden from assistive tech. Clicking the label toggles too. */}
      <label htmlFor={id} aria-hidden="true">
        {label}
      </label>
      <span className="cb-switch-field-state" aria-hidden="true">
        {props.checked ? (onText ?? t("switch.on")) : (offText ?? t("switch.off"))}
      </span>
    </span>
  );
}

export type SwitchListRow = {
  id: string;
  name: string;
  description?: string;
  /** Muted text before the switch, such as the policy ("Auto", "Needs approval"). */
  meta?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
};

/**
 * A list of switches (spec §5.3, §6.3): one `row.roomy` row per item with the name, a prose
 * description, muted meta text and the switch; rows are divided by `line-soft`. Put it in a
 * `flush` FormSection so the rows reach the card's edges.
 */
export function SwitchList({ label, rows }: { label: string; rows: SwitchListRow[] }) {
  return (
    <ul className="cb-switch-list" data-part="switch-list" aria-label={label}>
      {rows.map((r) => (
        <li key={r.id} className="cb-switch-row" data-part="switch-row">
          <span className="cb-switch-row-text">
            <span className="cb-switch-row-name" title={r.name}>
              {r.name}
            </span>
            {r.description ? (
              <span className="cb-switch-row-desc" title={r.description}>
                {r.description}
              </span>
            ) : null}
          </span>
          {r.meta ? <span className="cb-switch-row-meta">{r.meta}</span> : null}
          <Switch
            label={r.name}
            checked={r.checked}
            onChange={r.onChange}
            {...(r.disabled !== undefined ? { disabled: r.disabled } : {})}
          />
        </li>
      ))}
    </ul>
  );
}
