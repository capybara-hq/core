import { type ReactNode, useId, useState } from "react";

export type DisclosureProps = {
  /** The always-visible line; the whole line is the toggle button. */
  summary: ReactNode;
  /** Open on first render (default closed). */
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * An expandable block (spec §6.5): a summary line as a button (`aria-expanded`, `▸` / `▾` faint on
 * the right) and, once open, the body under it with a 1px `line` guide on the left. The body is
 * rendered only while open.
 */
export function Disclosure({ summary, defaultOpen = false, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="cb-disclosure">
      <button
        type="button"
        className="cb-row-toggle cb-disclosure-summary"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {summary}
        <span className="cb-row-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
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
