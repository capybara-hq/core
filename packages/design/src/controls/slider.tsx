import type { KeyboardEvent } from "react";

const CELLS = 20;

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  withInput,
}: {
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  label: string;
  withInput?: boolean;
}) {
  const decimals = (String(step).split(".")[1] ?? "").length;
  const commit = (n: number) => onChange(Number(Math.min(max, Math.max(min, n)).toFixed(decimals)));
  const onKeyDown = (e: KeyboardEvent) => {
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
        className="cb-slider"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        data-state={value === undefined ? "unset" : "set"}
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
          min={min}
          max={max}
          step={step}
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
