import { type ReactNode, useId } from "react";

export type ContentSectionProps = {
  /** The heading (an `h2`, spec §6.31). */
  title: string;
  /** How many items it holds, in `faint` after the title. */
  count?: number;
  /** One help line under the heading (small, muted, prose). */
  description?: ReactNode;
  /** Controls at the right of the heading row (a dense button or link). */
  actions?: ReactNode;
  /** The section holds nothing: this muted line is drawn instead of the children. */
  empty?: string;
  children?: ReactNode;
};

/**
 * One section of a detail or review page's single column (spec §6.31): a region named by its
 * heading, the heading in the `h2` step so it reads as a heading over its content, then an optional
 * help line and the content, or the `empty` line (small, muted) when it holds nothing.
 */
export function ContentSection({
  title,
  count,
  description,
  actions,
  empty,
  children,
}: ContentSectionProps) {
  const id = useId();
  return (
    <section className="cb-content-section" data-part="content-section" aria-labelledby={id}>
      <div className="cb-content-section-head">
        <h2 id={id} className="cb-content-section-title" data-part="content-section-title">
          {title}
        </h2>
        {count !== undefined ? (
          <span className="cb-content-section-count" data-part="content-section-count">
            {count}
          </span>
        ) : null}
        {actions ? <div className="cb-content-section-actions">{actions}</div> : null}
      </div>
      {description ? (
        <p className="cb-content-section-description" data-part="content-section-description">
          {description}
        </p>
      ) : null}
      {empty !== undefined ? (
        <p className="cb-content-section-empty" data-part="content-section-empty">
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  );
}
