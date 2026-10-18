import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import type { ControlA11y } from "./a11y";

const CELLS = 20;

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  withInput,
  placeholder,
  disabled,
  ...a11y
}: ControlA11y & {
  disabled?: boolean;
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  label: string;
  withInput?: boolean;
  /** 数值框的占位文字（如「默认（1）」）；未设置值时数值框留空并显示它。 */
  placeholder?: string;
}) {
  const decimals = (String(step).split(".")[1] ?? "").length;
  const commit = (n: number) => onChange(Number(Math.min(max, Math.max(min, n)).toFixed(decimals)));
  const dragging = useRef(false);
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const snapped = min + Math.round((ratio * (max - min)) / step) * step;
    commit(snapped);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    fromPointer(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current && !disabled) fromPointer(e);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    const from = value ?? (min + max) / 2;
    const delta: Record<string, number> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
      PageUp: step * 10,
      PageDown: -step * 10,
    };
    if (e.key === "Home") commit(min);
    else if (e.key === "End") commit(max);
    else if (e.key in delta) commit(from + (delta[e.key] as number));
    else return;
    e.preventDefault();
  };
  const ratio = value === undefined ? 0.5 : (value - min) / (max - min || 1);
  const filled = value === undefined ? 0 : Math.round(ratio * CELLS);
  return (
    <div className="cb-slider-wrap" data-with-input={withInput ? "true" : undefined}>
      <div
        {...a11y}
        className="cb-slider"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled ? true : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        data-state={disabled ? "disabled" : value === undefined ? "unset" : "set"}
        onKeyDown={onKeyDown}
      >
        <div className="cb-slider-track" aria-hidden="true">
          {Array.from({ length: CELLS }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定格数
            <span key={i} data-on={i < filled ? "true" : undefined} />
          ))}
        </div>
        <span className="cb-slider-thumb" aria-hidden="true" style={{ left: `${ratio * 100}%` }} />
      </div>
      {withInput ? (
        <input
          className="cb-slider-input"
          type="number"
          aria-label={label}
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n)) commit(n);
          }}
        />
      ) : null}
    </div>
  );
}
