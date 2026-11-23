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
