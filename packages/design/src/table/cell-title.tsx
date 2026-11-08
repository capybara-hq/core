import { MarkImage } from "../display/object-mark";

/**
 * The two-line name cell of a roomy row (spec §6.6): an optional mark tile (an initial, or a
 * plugin's icon with the initial as its fallback), the name, and a one-line prose description in
 * `muted`; both lines truncate with the full text in `title`.
 */
export function CellTitle({
  title,
  description,
  initial,
  image,
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
  /**
   * For a thing a plugin brings (an extension, a model provider): the plugin's declared icon,
   * contained on the same tile; without it, or when it fails to load, `initial` (else the title's
   * initial) is drawn (spec §6.17, maintainer decision 2026-11-08).
   */
  image?: string | null;
}) {
  return (
    <span className="cb-cell-title">
      {image ? (
        <span className="cb-cell-initial" data-kind="image" aria-hidden="true">
          <MarkImage src={image} text={initial ?? title} size={20} />
        </span>
      ) : initial ? (
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
