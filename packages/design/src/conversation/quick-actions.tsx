import type { JSX } from "react";
import { useDesignT } from "../provider";
import { ConvMenu } from "./menu";

/** A quick action's title; the page keeps its body and fills the composer on `onPick`. */
export type QuickActionItem = { id: string; title: string };

export type QuickActionsProps = {
  items: QuickActionItem[];
  onPick(id: string): void;
  /** Links before 「更多」 (default 4). */
  max?: number;
  /** Replaces 「更多」. */
  moreLabel?: string;
  /** The line's accessible name; default 「常用任务」. */
  label?: string;
  /** The reference set only: the overflow menu drawn open in place. */
  referenceOpen?: boolean;
};

/**
 * The selected agent's quick actions (§6.16.27, agent profile design §4.3, U1: quiet): one line of
 * `muted` `small` text links with no border, `ink` on hover and focus, each title on one line with
 * an ellipsis (the whole title is its tooltip). The first `max` show; the rest open from a quiet
 * 「更多」 in a small menu. No items: nothing.
 */
export function QuickActions({
  items,
  onPick,
  max = 4,
  moreLabel,
  label,
  referenceOpen,
}: QuickActionsProps): JSX.Element | null {
  const t = useDesignT();
  if (items.length === 0) return null;
  const n = Math.max(1, max);
  const shown = items.slice(0, n);
  const rest = items.slice(n);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a line of links, not a form control group
    <div
      className="cb-quick-actions"
      data-part="quick-actions"
      role="group"
      aria-label={label ?? t("quick.label")}
    >
      {shown.map((it) => (
        <button
          key={it.id}
          type="button"
          className="cb-quick-action"
          data-part="quick-action"
          title={it.title}
          onClick={() => onPick(it.id)}
        >
          {it.title}
        </button>
      ))}
      {rest.length > 0 ? (
        <ConvMenu
          inline={referenceOpen === true}
          label={label ?? t("quick.label")}
          size="narrow"
          bounded
          trigger={
            <button type="button" className="cb-quick-action" data-part="quick-more">
              {moreLabel ?? t("quick.more")}
            </button>
          }
          entries={rest.map((it) => ({
            kind: "item" as const,
            id: it.id,
            label: it.title,
            onSelect: () => onPick(it.id),
          }))}
        />
      ) : null}
    </div>
  );
}
