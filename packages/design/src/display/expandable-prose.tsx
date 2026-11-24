import { useId, useState } from "react";
import { Icon } from "../icons/icon";

export type ExpandableProseProps = {
  /** The collapsed text (a description's first sentence). */
  summary: string;
  /** The whole text; line breaks are kept. When it equals `summary` no toggle is drawn. */
  text: string;
  /** The toggle's label while collapsed (the owner's words, translated by the page). */
  moreLabel: string;
  /** The toggle's label while open. */
  lessLabel: string;
};

/**
 * A prose paragraph that shows its summary followed inline by a small muted toggle (spec §6.5):
 * opening shows the whole text with the toggle at its end. The toggle has the look of a
 * DisclosureLinks item (small muted text, a 12 px chevron after the words).
 */
export function ExpandableProse({ summary, text, moreLabel, lessLabel }: ExpandableProseProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const expandable = summary !== text;
  return (
    <p id={id} className="cb-expandable-prose">
      {expandable && open ? text : summary}
      {expandable ? (
        <>
          {" "}
          <button
            type="button"
            className="cb-disclosure-link cb-expandable-prose-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            {open ? lessLabel : moreLabel}
            <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
          </button>
        </>
      ) : null}
    </p>
  );
}
