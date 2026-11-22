import { type KeyboardEvent, useRef } from "react";
import { useHaptics } from "../native";
import { Avatar, type AvatarValue } from "./avatar";

export type ScopeChipOption = {
  value: string;
  label: string;
  /** An agent's avatar before the label (`null`: the initial of the label). */
  avatar?: AvatarValue;
  count?: number;
};

export type ScopeChipsProps = {
  /** The group's accessible name. */
  label: string;
  value: string;
  options: ScopeChipOption[];
  onChange(value: string): void;
};

/**
 * A row of scope chips (responsive system spec §2.2 level 2, the list template's view choice;
 * the minimal form this line needs, which phase 0's `ListPage.scope` absorbs): pills in one row
 * that scrolls sideways, the selected one an `ink` fill with page-ground text. A single choice
 * (`radiogroup`): arrow keys move it, and only the selected chip is in the tab order.
 */
export function ScopeChips({ label, value, options, onChange }: ScopeChipsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const haptics = useHaptics();
  const change = (next: string) => {
    if (next !== value) haptics("selection");
    onChange(next);
  };
  const onKey = (e: KeyboardEvent) => {
    const idx = options.findIndex((o) => o.value === value);
    let next: ScopeChipOption | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = options[(idx + 1) % options.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = options[(idx - 1 + options.length) % options.length];
    if (!next) return;
    e.preventDefault();
    change(next.value);
    ref.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  const selectedShown = options.some((o) => o.value === value);
  return (
    <div
      className="cb-scope-chips"
      data-part="scope-chips"
      role="radiogroup"
      aria-label={label}
      ref={ref}
      onKeyDown={onKey}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a chip is a radio of the group
          <button
            key={o.value}
            type="button"
            role="radio"
            className="cb-scope-chip"
            data-part="scope-chip"
            data-value={o.value}
            aria-checked={selected}
            tabIndex={selected || (!selectedShown && i === 0) ? 0 : -1}
            data-state={selected ? "selected" : undefined}
            onClick={() => change(o.value)}
          >
            {o.avatar !== undefined ? <Avatar value={o.avatar} name={o.label} size={16} /> : null}
            <span className="cb-scope-chip-label">{o.label}</span>
            {o.count !== undefined ? <span className="cb-scope-chip-count">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
