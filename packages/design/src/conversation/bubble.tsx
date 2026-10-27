import type { JSX, ReactNode } from "react";
import { isSafeAttachmentHref } from "../display/attachments";

export type UserBubbleProps = {
  text: string;
  /** Shown above the bubble, right-aligned (usually {@link BubbleAttachments}). */
  attachments?: ReactNode;
  /** The queued form (§6.16.14): dashed border, translucent. */
  queued?: boolean;
};

/** A user message (§6.16.6): right-aligned `selected` bubble, at most 75% of the thread. */
export function UserBubble({ text, attachments, queued }: UserBubbleProps): JSX.Element {
  return (
    <div className="cb-user-msg">
      {attachments}
      <div className="cb-bubble" data-part="bubble" data-queued={queued ? "true" : undefined}>
        {text}
      </div>
    </div>
  );
}

export type BubbleAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  /** Type badge (e.g. "PDF"). */
  type?: string;
  /** Formatted size. */
  size?: string;
  /** Thumbnail source of an image (http(s) or same-origin path; anything else is not loaded). */
  src?: string;
};

/** Attachments of a sent message: image thumbnails, then file chips, each opening on click. */
export function BubbleAttachments({
  items,
  onOpen,
}: {
  items: BubbleAttachment[];
  onOpen?(id: string): void;
}): JSX.Element {
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind === "file");
  return (
    <div className="cb-bubble-atts">
      {images.length > 0 ? (
        <div className="cb-bubble-thumbs">
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              className="cb-bubble-thumb"
              data-part="thumb"
              aria-label={a.name}
              onClick={() => onOpen?.(a.id)}
            >
              {a.src !== undefined && isSafeAttachmentHref(a.src) ? (
                <img src={a.src} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {files.map((a) => (
        <button
          key={a.id}
          type="button"
          className="cb-bubble-file"
          data-part="attachment"
          onClick={() => onOpen?.(a.id)}
        >
          {a.type ? <span className="cb-type-badge">{a.type}</span> : null}
          <span className="cb-bubble-file-name">{a.name}</span>
          {a.size ? <span className="cb-muted">{a.size}</span> : null}
        </button>
      ))}
    </div>
  );
}
