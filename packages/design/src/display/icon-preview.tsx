// An app icon on a light and on a dark ground (spec §6.49; mobile layout spec §10.2.1).

export type IconPreviewProps = {
  /** The icon picture (an upload's URL, or the web's default). */
  src: string;
  /**
   * A caption and accessible name per ground. Without it the tiles are decorative and draw no
   * caption.
   */
  labels?: { light: string; dark: string };
};

const GROUNDS = ["light", "dark"] as const;

/**
 * One icon drawn twice, side by side: on `preview-light` and on `preview-dark`, the two grounds
 * that are the same in both themes, so an icon is judged on both whatever the page's theme is.
 * Not interactive.
 */
export function IconPreview({ src, labels }: IconPreviewProps) {
  return (
    <div className="cb-icon-preview" data-part="icon-preview">
      {GROUNDS.map((ground) => (
        <figure className="cb-icon-preview-item" key={ground}>
          <div
            className="cb-icon-preview-tile"
            data-part="icon-preview-tile"
            data-ground={ground}
            {...(labels
              ? { role: "img", "aria-label": labels[ground] }
              : { "aria-hidden": true as const })}
          >
            <img
              className="cb-icon-preview-image"
              data-part="icon-preview-image"
              src={src}
              alt=""
              draggable={false}
            />
          </div>
          {labels ? (
            <figcaption className="cb-icon-preview-label" data-part="icon-preview-label">
              {labels[ground]}
            </figcaption>
          ) : null}
        </figure>
      ))}
    </div>
  );
}
