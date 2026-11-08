import type { ReactNode } from "react";

export type InstructionListProps = {
  /** The steps, plain text; a backtick pair (`like this`) is drawn as inline code. */
  items: string[];
  /** The list's accessible name. */
  label?: string;
};

/** Plain text with backtick pairs as inline code; nothing else is markup (no HTML, no links). */
function segments(text: string): ReactNode[] {
  return text.split(/`([^`\n]+)`/).map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
      <code key={i} className="cb-md-code" data-part="inline-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/**
 * Numbered instructions a person follows outside the product (spec §6.9: a plugin's setup guide
 * steps): each step's number in `faint` mono, its text in the prose font; text only, a backtick
 * pair is inline code. Unlike StepList there is no done / to-do state.
 */
export function InstructionList({ items, label }: InstructionListProps) {
  return (
    <ol className="cb-instructions" aria-label={label} data-part="instruction-list">
      {items.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list whose texts may repeat
        <li key={i} className="cb-instructions-item" data-part="instruction">
          <span className="cb-instructions-num" aria-hidden="true">
            {i + 1}
          </span>
          <span className="cb-instructions-text">{segments(text)}</span>
        </li>
      ))}
    </ol>
  );
}
