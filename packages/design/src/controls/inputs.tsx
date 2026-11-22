import {
  type FocusEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useRef,
} from "react";
import { useDesignT } from "../provider";
import { KEYBOARD_INSET_SETTLED_EVENT } from "../shell/keyboard-settled";
import { readMobileSizes, useMobileSizes } from "../shell/touch";
import type { ControlA11y } from "./a11y";
import { type Density, useDensity } from "./density";
import { useNumberDraft } from "./number-draft";
import { stepDecimals } from "./step";

function inScroller(el: HTMLElement): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) return true;
  }
  return false;
}

// One settled listener at a time, installed while a field has focus (spec §5 "Scroll to input").
let focusedField: HTMLElement | null = null;

function scrollFocusedIntoView() {
  const el = focusedField;
  if (el && readMobileSizes() && inScroller(el)) el.scrollIntoView({ block: "nearest" });
}

/**
 * Under the mobile query, a focused field inside a scroller is scrolled into view above the
 * keyboard once the shell's inset has settled (mobile interaction model §5); props for the control.
 * The scrollers' `scroll-padding-bottom` (shell.css) keeps the field clear of the keyboard.
 */
function useScrollIntoViewOnKeyboard<E extends HTMLElement>(
  onFocus?: (e: FocusEvent<E>) => void,
  onBlur?: (e: FocusEvent<E>) => void,
) {
  const mobile = useMobileSizes() === true;
  const own = useRef<HTMLElement | null>(null);
  // An unmounted field no longer holds the listener
  useEffect(() => () => (own.current ? releaseField(own.current) : undefined), []);
  return {
    onFocus: (e: FocusEvent<E>) => {
      if (mobile) {
        if (!focusedField)
          window.addEventListener(KEYBOARD_INSET_SETTLED_EVENT, scrollFocusedIntoView);
        focusedField = own.current = e.currentTarget;
        // The keyboard is already open (moving between fields): no inset change will follow.
        if (document.documentElement.dataset.keyboard === "open") scrollFocusedIntoView();
      }
      onFocus?.(e);
    },
    onBlur: (e: FocusEvent<E>) => {
      releaseField(e.currentTarget);
      onBlur?.(e);
    },
  };
}

function releaseField(el: HTMLElement) {
  if (focusedField !== el) return;
  focusedField = null;
  window.removeEventListener(KEYBOARD_INSET_SETTLED_EVENT, scrollFocusedIntoView);
}

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
  const scroll = useScrollIntoViewOnKeyboard<HTMLInputElement>(rest.onFocus, rest.onBlur);
  return (
    <div
      className="cb-input"
      data-part="input"
      data-cap-part="input"
      data-density={step}
      data-state={
        rest.disabled ? "disabled" : invalid || rest["aria-invalid"] ? "error" : undefined
      }
    >
      {prefix ? <span className="cb-input-affix">{prefix}</span> : null}
      <input
        {...rest}
        {...scroll}
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
  const scroll = useScrollIntoViewOnKeyboard<HTMLTextAreaElement>(rest.onFocus, rest.onBlur);
  return (
    <div
      className="cb-textarea"
      data-part="textarea"
      data-cap-part="input"
      data-state={rest.disabled ? "disabled" : rest["aria-invalid"] ? "error" : undefined}
    >
      <textarea {...rest} {...scroll} data-code={code ? "true" : undefined} />
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
