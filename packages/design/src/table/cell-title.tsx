/**
 * The two-line name cell of a roomy row (spec §6.6): an optional initial tile, the name, and a
 * one-line prose description in `muted`; both lines truncate with the full text in `title`.
 */
export function CellTitle({
  title,
  description,
  initial,
}: {
  title: string;
  description?: string;
  /** One character drawn on a `selected` tile before the text (e.g. the name's first letter). */
  initial?: string;
}) {
  return (
    <span className="cb-cell-title">
      {initial ? (
        <span className="cb-cell-initial" aria-hidden="true">
          {initial}
        </span>
      ) : null}
      <span className="cb-cell-title-text">
        <span className="cb-cell-title-name" title={title}>
          {title}
        </span>
        {description ? (
          <span className="cb-cell-title-desc" title={description}>
            {description}
          </span>
        ) : null}
      </span>
    </span>
  );
}
