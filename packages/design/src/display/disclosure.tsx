import { type ReactNode, useId, useState } from "react";
import { Icon } from "../icons/icon";

export type DisclosureProps = {
  /** The always-visible line; the whole line is the toggle button. */
  summary: ReactNode;
  /** Open on first render (default closed). */
  defaultOpen?: boolean;
  /**
   * Controlled: the block is open exactly when this is true (the owner opens it itself, e.g. to
   * show an error inside); `onOpenChange` reports the summary's toggles.
   */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  children: ReactNode;
};

/**
 * An expandable block (spec §6.5): a summary line as a button (`aria-expanded`, a faint
 * `chevron-right` / `chevron-down` icon on the right) and, once open, the body under it with a 1px `line` guide on the left. The body is
 * rendered only while open. Uncontrolled by default (`defaultOpen`); `open` + `onOpenChange` hand
 * the state to the owner.
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  children,
}: DisclosureProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  const id = useId();
  return (
    <div className="cb-disclosure">
      <button
        type="button"
        className="cb-row-toggle cb-disclosure-summary"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {summary}
        <span className="cb-row-caret" aria-hidden="true">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </span>
      </button>
      {open ? (
        <div id={id} className="cb-disclosure-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export type DisclosureLinkItem = {
  /** Stable key of the item. */
  key: string;
  /** The link's text (a full description, a license, a host line). */
  summary: ReactNode;
  children: ReactNode;
};

/**
 * A row of inline disclosures (spec §6.5): small muted text buttons, each followed by its chevron,
 * side by side and wrapping; at most one is open, and its body shows under the row with the
 * Disclosure's 1px `line` guide. For the secondary texts of a block (a full description, a license,
 * a file body) that a full-width Disclosure line would make look as heavy as the content.
 */
export function DisclosureLinks({ items }: { items: DisclosureLinkItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const id = useId();
  const shown = items.find((i) => i.key === open);
  if (items.length === 0) return null;
  return (
    <div className="cb-disclosure cb-disclosure-links" data-part="disclosure-links">
      <div className="cb-disclosure-links-row">
        {items.map((i) => {
          const expanded = shown?.key === i.key;
          return (
            <button
              key={i.key}
              type="button"
              className="cb-disclosure-link"
              aria-expanded={expanded}
              aria-controls={expanded ? id : undefined}
              onClick={() => setOpen(expanded ? null : i.key)}
            >
              {i.summary}
              <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
            </button>
          );
        })}
      </div>
      {shown !== undefined ? (
        <div id={id} className="cb-disclosure-body">
          {shown.children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One DisclosureLinks-look button (spec §6.5) for a secondary text that opens elsewhere, in
 * a Dialog (a license's full text): `small` `muted` words and a `chevron-right` 12, inline after a
 * value.
 */
export function DisclosureLink({ onSelect, children }: { onSelect(): void; children: ReactNode }) {
  return (
    <button type="button" className="cb-disclosure-link" aria-haspopup="dialog" onClick={onSelect}>
      {children}
      <Icon name="chevron-right" size={12} />
    </button>
  );
}
