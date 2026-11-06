import { type ReactNode, useId } from "react";

export type SubsectionProps = {
  /** The heading (an `h3` in the `body` step, 500). */
  title: string;
  /** How many items it holds, in `faint` after the title. */
  count?: number;
  /** One help line under the heading (`small`, `muted`, prose). */
  description?: ReactNode;
  /** Controls at the right of the heading row (dense buttons, a status word). */
  actions?: ReactNode;
  /**
   * `guide` (default): inside a padded box, the content under a 1px `line` guide on the left, as
   * a Disclosure's body (a nested config object). `flush`: inside a flush box (a `flush`
   * FormSection), the heading row padded `space.3` (in line with a table's first column) and the
   * content running to the box's edges (an unframed DataTable); a flush subsection after another
   * is split by a `line-soft` hairline.
   */
  variant?: "guide" | "flush";
  children?: ReactNode;
};

/**
 * A group inside one box (spec §6.32, §1 "One box is enough"): where a second Card would have
 * stood, a heading, its help line and the content. A `region` named by its heading.
 */
export function Subsection({
  title,
  count,
  description,
  actions,
  variant = "guide",
  children,
}: SubsectionProps) {
  const id = useId();
  return (
    <section
      className="cb-subsection"
      data-part="subsection"
      data-variant={variant}
      aria-labelledby={id}
    >
      <div className="cb-subsection-head" data-part="subsection-head">
        <div className="cb-subsection-heading">
          <h3 id={id} className="cb-subsection-title" data-part="subsection-title">
            {title}
          </h3>
          {count !== undefined ? (
            <span className="cb-subsection-count" data-part="subsection-count">
              {count}
            </span>
          ) : null}
          {actions ? <div className="cb-subsection-actions">{actions}</div> : null}
        </div>
        {description ? (
          <p className="cb-subsection-description" data-part="subsection-description">
            {description}
          </p>
        ) : null}
      </div>
      <div className="cb-subsection-body" data-part="subsection-body">
        {children}
      </div>
    </section>
  );
}
