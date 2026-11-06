import { type JSX, useRef, useState } from "react";
import { IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { useMenuAboveComposer } from "./composer";
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
 * `quickActions`). It opens a small menu above the composer, like the pickers', listing every
 * quick action by title (a long title cut with an ellipsis); choosing one closes it and then
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
  const { trigger, offset, measure } = useMenuAboveComposer(referenceOpen === true);
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
      side="top"
      sideOffset={offset}
      align="start"
      size="narrow"
      bounded
      open={open}
      onOpenChange={(o) => {
        if (o) measure();
        setOpen(o);
      }}
      onCloseAutoFocus={(e) => {
        const id = picked.current;
        picked.current = null;
        if (id === null) return;
        e.preventDefault();
        onPick(id);
      }}
      trigger={
        <IconButton
          ref={trigger}
          part="quick-actions"
          label={name}
          icon={<Icon name="zap" size={16} />}
        />
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
