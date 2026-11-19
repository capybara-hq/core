import { type JSX, useState } from "react";
import { Button } from "../controls/button";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { ConvMenu, type ConvMenuEntry } from "./menu";

// The composer's mode menu (spec §6.16.3a): one button at the end of the control row showing the
// current permission profile, opening a menu with the profiles and, under a hairline, the
// reasoning effort. It replaces the separate permission and effort pickers from 640 up.

/** One mode (a permission profile) of the mode menu. */
export type ModeMenuMode = {
  id: string;
  label: string;
  icon: IconName;
  /** One line under the label saying what the mode does. */
  description: string;
  checked?: boolean;
  /** Not choosable now; `tag` says why ("请先选择设备"). */
  disabled?: boolean;
  tag?: string;
};

export type ModeMenuProps = {
  /** What the menu chooses, its accessible name and the head of the menu ("权限"). */
  label: string;
  /** The key hint in the head ("⇧Tab 切换"); absent when the modes cannot change. */
  hint?: string;
  modes: ModeMenuMode[];
  onPickMode(id: string): void;
  /**
   * Read-only modes (a recorded or inherited profile): every mode is shown disabled, there is no
   * key hint, and this sentence closes the modes as the menu's note. The effort stays choosable.
   */
  locked?: string;
  /** The reasoning effort, only when the selected model declares efforts. */
  effort?: {
    label: string;
    items: { id: string; label: string; checked?: boolean }[];
    onPick(id: string): void;
  };
  /**
   * A transient fact closing the modes ("设备启动时检查"), never a standing explanation; a locked
   * menu's reason comes first.
   */
  note?: string;
  /** One plain action after the modes ("设置审查模型" for an org admin); it closes the menu. */
  action?: { label: string; icon?: IconName; onSelect(): void };
  /** The reference set and catalog only: the menu drawn open in place. */
  referenceOpen?: boolean;
  disabled?: boolean;
};

/** The modes as menu entries: the head, the described rows, the action, the effort segments. */
export function modeMenuEntries(p: ModeMenuProps): ConvMenuEntry[] {
  const entries: ConvMenuEntry[] = [
    {
      kind: "label",
      label: p.label,
      ...(p.locked === undefined && p.hint !== undefined ? { hint: p.hint } : {}),
    },
  ];
  for (const m of p.modes) {
    const disabled = p.locked !== undefined || m.disabled === true;
    entries.push({
      kind: "item",
      id: m.id,
      label: m.label,
      icon: m.icon,
      description: m.description,
      ...(m.tag !== undefined && p.locked === undefined ? { tag: m.tag } : {}),
      checked: m.checked === true,
      ...(disabled ? { disabled: true } : {}),
      onSelect: () => p.onPickMode(m.id),
    });
  }
  const note = [p.locked, p.note].filter((x) => x !== undefined).join(" ");
  if (note !== "") entries.push({ kind: "note", text: note });
  if (p.action !== undefined)
    entries.push(
      { kind: "separator" },
      {
        kind: "item",
        id: "mode-action",
        label: p.action.label,
        ...(p.action.icon !== undefined ? { icon: p.action.icon } : {}),
        onSelect: p.action.onSelect,
      },
    );
  if (p.effort !== undefined)
    entries.push(
      { kind: "separator" },
      {
        kind: "segments",
        label: p.effort.label,
        items: p.effort.items,
        onSelect: p.effort.onPick,
      },
    );
  return entries;
}

/**
 * The mode button and its menu (§6.16.3a): a ghost picker-styled button with the current mode's
 * icon and label and a `chevron-down`, opening above the composer. Arrow keys move through the
 * modes and the effort segments, Enter or Space picks, Escape closes; focus returns to the button.
 */
export function ModeMenu(p: ModeMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const current = p.modes.find((m) => m.checked) ?? p.modes[0];
  const effort = p.effort?.items.find((i) => i.checked);
  const name = [p.label, current?.label, effort ? `${p.effort?.label} ${effort.label}` : undefined]
    .filter((x) => x !== undefined)
    .join(": ");
  return (
    <ConvMenu
      inline={p.referenceOpen === true}
      label={p.label}
      anchored
      side="top"
      align="end"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="ghost"
          className="cb-picker cb-mode-button"
          part="mode-button"
          aria-label={name}
          // locked: the reason on hover, as a locked picker's
          title={p.locked ?? current?.description}
          data-locked={p.locked !== undefined ? "true" : undefined}
          disabled={p.disabled}
        >
          {current ? <Icon name={current.icon} size={14} /> : null}
          <span className="cb-picker-value" data-part="picker-value">
            {current?.label}
          </span>
          <Icon name="chevron-down" size={12} />
        </Button>
      }
      entries={modeMenuEntries(p)}
    />
  );
}

/**
 * The next mode Shift+Tab moves to from the checked one: the following choosable mode, wrapping
 * around; undefined when no other mode can be chosen (or the modes are locked).
 */
export function nextMode(p: Pick<ModeMenuProps, "modes" | "locked">): string | undefined {
  if (p.locked !== undefined) return undefined;
  const at = p.modes.findIndex((m) => m.checked);
  for (let i = 1; i < p.modes.length; i++) {
    const m = p.modes[(at + i + p.modes.length) % p.modes.length];
    if (m !== undefined && m.disabled !== true && !m.checked) return m.id;
  }
  return undefined;
}
