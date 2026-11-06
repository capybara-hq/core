/**
 * The two-line name cell of a roomy row (spec §6.6): an optional initial tile, the name, and a
 * one-line prose description in `muted`; both lines truncate with the full text in `title`.
 */
export function CellTitle({
  title,
  description,
  initial,
  mono = false,
  trailing,
}: {
  title: string;
  /**
   * A short mono label after the title on its line (a version, `v0.1.0`): it never takes the
   * ellipsis, the title does (spec §6.6).
   */
  trailing?: string;
  description?: string;
  /** The description is an id or a version (`plugin · v1.0.0`): mono instead of prose. */
  mono?: boolean;
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
        {trailing ? (
          <span className="cb-cell-title-line">
            <span className="cb-cell-title-name" title={title}>
              {title}
            </span>
            <span className="cb-cell-title-trailing" data-part="cell-title-trailing">
              {trailing}
            </span>
          </span>
        ) : (
          <span className="cb-cell-title-name" title={title}>
            {title}
          </span>
        )}
        {description ? (
          <span
            className="cb-cell-title-desc"
            data-mono={mono ? "true" : undefined}
            title={description}
          >
            {description}
          </span>
        ) : null}
      </span>
    </span>
  );
}
