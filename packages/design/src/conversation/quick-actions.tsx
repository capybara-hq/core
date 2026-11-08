import { type JSX, useId, useRef, useState } from "react";
import { IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { ConvMenu } from "./menu";

/** A quick action's title; the page keeps its body and fills the composer on `onPick`. */
export type QuickActionItem = { id: string; title: string };

export type QuickActionsProps = {
  items: QuickActionItem[];
  onPick(id: string): void;
  /** The button's and the menu's accessible name; default 「常用任务」. */
  label?: string;
  /** The reference set only: the menu drawn open in place. */
  referenceOpen?: boolean;
};

/**
 * The selected agent's quick actions (§6.16.27, agent profile design §4.3): a ghost `zap` icon
 * button in the composer's control row, right after the effort picker (`ComposerBox`'s
 * `quickActions`). It opens an anchored menu like the pickers' (§6.16.3: below or above the
 * button, capped, filtered past ten items) listing every quick action by title (a long title cut
 * with an ellipsis); choosing one closes it and then
 * calls `onPick`, leaving the focus where that puts it (the composer); Escape returns it to the
 * button. No items: nothing.
 */
export function QuickActions({
  items,
  onPick,
  label,
  referenceOpen,
}: QuickActionsProps): JSX.Element | null {
  const t = useDesignT();
  const [open, setOpen] = useState(false);
  // A pick runs once the menu has closed, its focus trap gone, so the focus can go where the page
  // puts it (the composer); Escape returns it to the button.
  const picked = useRef<string | null>(null);
  if (items.length === 0) return null;
  const name = label ?? t("quick.label");
  return (
    <ConvMenu
      inline={referenceOpen === true}
      label={name}
      anchored
      // drawn open in place (the reference set): above, as on the conversation page
      side="top"
      align="start"
      open={open}
      onOpenChange={setOpen}
      onCloseAutoFocus={(e) => {
        const id = picked.current;
        picked.current = null;
        if (id === null) return;
        e.preventDefault();
        onPick(id);
      }}
      trigger={
        <IconButton part="quick-actions" label={name} icon={<Icon name="zap" size={16} />} />
      }
      entries={items.map((it) => ({
        kind: "item" as const,
        id: it.id,
        label: it.title,
        onSelect: () => {
          picked.current = it.id;
        },
      }))}
    />
  );
}

export type QuickActionListProps = {
  items: QuickActionItem[];
  /** The same handler the `zap` menu calls: the page fills the composer. */
  onPick(id: string): void;
  /** The list's heading; default 「常用任务」. */
  label?: string;
};

/**
 * The selected agent's quick actions listed on a phone's new conversation (§5.4, §6.16.27): a
 * heading over plain rows (no box), one tappable row per title in the agent's order, filling the
 * space between the agents row and the composer pinned at the bottom. A tap calls `onPick`, as
 * choosing it from the `zap` menu does. No items: nothing. `ConversationPage` shows it below 640
 * only, and hides the composer's `zap` button there.
 */
export function QuickActionList({
  items,
  onPick,
  label,
}: QuickActionListProps): JSX.Element | null {
  const t = useDesignT();
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section className="cb-quick-list" data-part="quick-action-list" aria-labelledby={id}>
      <h3 className="cb-quick-list-title" id={id}>
        {label ?? t("quick.label")}
      </h3>
      <ul className="cb-quick-list-items">
        {items.map((it) => (
          <li key={it.id} className="cb-quick-list-row">
            <button
              type="button"
              className="cb-quick-list-item"
              data-part="quick-action-item"
              title={it.title}
              onClick={() => onPick(it.id)}
            >
              <span className="cb-quick-list-mark">
                <Icon name="zap" size={14} />
              </span>
              <span className="cb-quick-list-text">{it.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
