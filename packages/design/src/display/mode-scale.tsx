import { type KeyboardEvent, type ReactNode, useRef } from "react";
import type { DesignKey } from "../i18n";
import { useDesignT } from "../provider";

/** How much power a device gives an agent's commands (auto mode design §4). */
export type DeviceMode = "auto" | "sandbox";

const MODES: readonly DeviceMode[] = ["auto", "sandbox"];

export type ModeScaleProps = {
  /** The mode the device runs at now. */
  value: DeviceMode;
  /**
   * Choosing a mode. Absent (or `locked`) makes the scale read-only: nothing can be chosen.
   * Never called with the mode already selected.
   */
  onSelect?: (mode: DeviceMode) => void;
  /** The one sentence under each mode; defaults to the design i18n (§7). */
  descriptions?: Partial<Record<DeviceMode, string>>;
  /**
   * A mode that cannot be chosen, with why (组织不允许 / 平台不允许): its option is drawn disabled
   * with the reason under it.
   */
  unavailable?: Partial<Record<DeviceMode, string>>;
  /** A cloud device chooses nothing: it shows the mode it runs at and why. */
  locked?: boolean;
  /** The line under the scale saying why a locked scale cannot change (a cloud device). */
  lockedReason?: string;
  /** The whole scale cannot be used now, with `disabledReason` under it. */
  disabled?: boolean;
  disabledReason?: string;
  /** The `KeycapCommand` line, under the scale (a local device's `capybara-device mode`). */
  command?: ReactNode;
  /** The group's accessible name; defaults to 运行模式 / "Run mode". */
  label?: string;
};

/**
 * A device's two modes as one horizontal scale (spec §6.42, auto mode design §4): 自动 | 沙箱,
 * each with one sentence and a thin marker under the effective one — never four stacked option
 * cards and never a full-bleed fill. A radio group with a roving tab stop: arrows move the
 * choice, Home / End jump to either end. A mode the org or the platform forbids is drawn disabled
 * with its reason under it (`unavailable`); a cloud device has no choice at all (`locked`, with
 * `lockedReason`); `disabled` turns the whole scale off. The `command` slot holds the
 * `KeycapCommand` a local device's owner runs on the machine.
 */
export function ModeScale({
  value,
  onSelect,
  descriptions,
  unavailable,
  locked = false,
  lockedReason,
  disabled = false,
  disabledReason,
  command,
  label,
}: ModeScaleProps) {
  const t = useDesignT();
  const groupLabel = label ?? t("modeScale.label");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const blocked = locked || disabled || onSelect === undefined;
  const enabled = MODES.filter((m) => !blocked && unavailable?.[m] === undefined);
  const stop = enabled.includes(value) ? value : enabled[0];
  const note = locked ? lockedReason : disabled ? disabledReason : undefined;

  const move = (from: DeviceMode, dir: 1 | -1 | "first" | "last") => {
    if (blocked || enabled.length === 0) return;
    const index = Math.max(0, enabled.indexOf(from));
    const nextIndex =
      dir === "first"
        ? 0
        : dir === "last"
          ? enabled.length - 1
          : (index + dir + enabled.length) % enabled.length;
    const next = enabled[nextIndex] as DeviceMode;
    refs.current[MODES.indexOf(next)]?.focus();
    if (next !== value) onSelect?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, mode: DeviceMode) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(mode, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(mode, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(mode, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      move(mode, "last");
    }
  };

  return (
    <div
      className="cb-mode-scale"
      data-part="mode-scale"
      data-mode={value}
      data-locked={locked ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
    >
      <div className="cb-mode-scale-head">
        <span className="cb-mode-scale-label" data-part="mode-scale-label">
          {groupLabel}
        </span>
        {note ? (
          <span className="cb-mode-scale-note" data-part="mode-scale-note">
            {note}
          </span>
        ) : null}
      </div>
      <div
        className="cb-mode-scale-options"
        data-part="mode-scale-options"
        role="radiogroup"
        aria-label={groupLabel}
      >
        <span className="cb-mode-scale-track" data-part="mode-scale-track" aria-hidden="true" />
        {MODES.map((mode, index) => {
          const selected = mode === value;
          const reason = unavailable?.[mode];
          const off = blocked || reason !== undefined;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a station is a button with role=radio
            <button
              key={mode}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              className="cb-mode-scale-option"
              data-part="mode-scale-option"
              data-mode={mode}
              data-state={selected ? "selected" : "default"}
              aria-checked={selected}
              aria-disabled={off ? "true" : undefined}
              disabled={off}
              tabIndex={mode === stop ? 0 : -1}
              onClick={() => {
                if (!off && !selected) onSelect?.(mode);
              }}
              onKeyDown={(event) => onKeyDown(event, mode)}
            >
              <span className="cb-mode-scale-name" data-part="mode-scale-name">
                {t(`modeScale.mode.${mode}` as DesignKey)}
              </span>
              <span
                className="cb-mode-scale-marker"
                data-part="mode-scale-marker"
                aria-hidden="true"
              />
              <span className="cb-mode-scale-description" data-part="mode-scale-description">
                {descriptions?.[mode] ?? t(`modeScale.description.${mode}` as DesignKey)}
              </span>
              {reason ? (
                <span className="cb-mode-scale-reason" data-part="mode-scale-reason">
                  {reason}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {command ? (
        <div className="cb-mode-scale-command" data-part="mode-scale-command">
          {command}
        </div>
      ) : null}
    </div>
  );
}
