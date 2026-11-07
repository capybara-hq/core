import { type ReactNode, useId } from "react";
import { SkeletonText } from "./skeleton";

export type SubsectionProps = {
  /** The heading (an `h3` in the `body` step, 500). */
  title: string;
  /** How many items it holds, in `faint` after the title. */
  count?: number;
  /**
   * One help line under the heading (`small`, `muted`, prose). A string is a paragraph; any other
   * node is a block in the same place (a `div`), for content with lines of its own: a provider's
   * listing error with its detail rows, which keep their own type step.
   */
  description?: ReactNode;
  /** Controls at the right of the heading row (dense buttons, a status word). */
  actions?: ReactNode;
  /**
   * `guide` (default): inside a padded box, the content under a 1px `line` guide on the left, as
   * a Disclosure's body (a nested config object). `flush`: inside a flush box (a `flush`
   * FormSection), the heading row padded `space.3` (in line with a table's first column) and the
   * content running to the box's edges (an unframed DataTable); a flush subsection after another
   * is split by a `line-soft` hairline. `divided`: one region of a Sheet's (or Dialog's) body,
   * the content under its heading with no guide; every divided subsection after the first among
   * its siblings is split from what is above by a `line-soft` hairline and `space.4`.
   */
  variant?: "guide" | "flush" | "divided";
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
          typeof description === "string" ? (
            <p className="cb-subsection-description" data-part="subsection-description">
              {description}
            </p>
          ) : (
            <div
              className="cb-subsection-description"
              data-part="subsection-description"
              data-block="true"
            >
              {description}
            </div>
          )
        ) : null}
      </div>
      <div className="cb-subsection-body" data-part="subsection-body">
        {children}
      </div>
    </section>
  );
}

/**
 * A subsection whose heading is not known yet (spec §6.32): the same frame with a skeleton bar in
 * the title's slot (one `body` line, so the loaded heading row does not move the content), then
 * the content (a loading table).
 */
export function LoadingSubsection({
  variant = "guide",
  children,
}: {
  variant?: "guide" | "flush";
  children?: ReactNode;
}) {
  return (
    <section className="cb-subsection" data-part="subsection" data-variant={variant}>
      <div className="cb-subsection-head" data-part="subsection-head">
        <div className="cb-subsection-heading" data-loading="true">
          <span className="cb-subsection-title" data-part="subsection-title">
            <SkeletonText width={120} />
          </span>
        </div>
      </div>
      <div className="cb-subsection-body" data-part="subsection-body">
        {children}
      </div>
    </section>
  );
}
