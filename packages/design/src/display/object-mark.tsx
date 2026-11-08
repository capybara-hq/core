import { useState } from "react";
import { initialOf } from "./initial";

/**
 * The picture inside a mark tile (spec §6.17, maintainer decision 2026-11-08): the plugin's declared
 * icon of a thing that plugin brings (a channel, an extension, a model provider), contained in the
 * tile and decorative (`alt=""`: the name is written next to it). Without `src`, or when the image
 * fails to load, the tile's initial: the upper-cased first grapheme of `text` (the one avatar-tile
 * rule). The src is a kernel route (`/api/v1/…/icon`), loaded only as an `<img>`, never inlined.
 */
export function MarkImage({ src, text, size }: { src?: string; text: string; size: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src === undefined || src === "" || failed === src) return <>{initialOf(text)}</>;
  return (
    <img
      className="cb-mark-image"
      data-part="mark-image"
      src={src}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}

/** The sizes of a standalone mark tile (spec §6.17). */
export type ObjectMarkSize = 24 | 28 | 40;

/** The image inside each tile size: two thirds of the tile, rounded to the icon grid. */
const IMAGE_SIZE: Record<ObjectMarkSize, number> = { 24: 16, 28: 20, 40: 24 };

/**
 * A mark tile on its own (spec §6.17): an item row's, a Sheet head's or a page head's mark for a
 * thing a plugin brings: the plugin's icon (`image`) contained on the `selected` tile, else the
 * initial of `text`. Decorative (`aria-hidden`).
 */
export function ObjectMark({
  text,
  image,
  size = 28,
}: {
  /** The display name: its initial when there is no image or it fails to load. */
  text: string;
  /** The plugin's icon (a kernel icon route). */
  image?: string | null;
  size?: ObjectMarkSize;
}) {
  return (
    <span
      className="cb-mark"
      data-part="object-mark"
      data-size={String(size)}
      data-kind={image ? "image" : "initial"}
      aria-hidden="true"
    >
      <MarkImage {...(image ? { src: image } : {})} text={text} size={IMAGE_SIZE[size]} />
    </span>
  );
}
