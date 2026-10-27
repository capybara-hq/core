import type { JSX, ReactNode } from "react";
import { isSafeAttachmentHref } from "../display/attachments";

export type UserBubbleProps = {
  text: string;
  /** Shown above the bubble, right-aligned (usually {@link BubbleAttachments}). */
  attachments?: ReactNode;
  /** The queued form (§6.16.14): dashed border, translucent. */
  queued?: boolean;
  /**
   * A skill invocation (phase D): the skill chip ("/fix-issue") before the text, which is then
   * the invocation's arguments.
   */
  skill?: string;
  /** Under the bubble, right-aligned: the "Skill instructions" disclosure, a waiting note. */
  details?: ReactNode;
};

/** The skill chip inside a bubble (§6.16.6): the composer's chip without its remove button. */
export function BubbleSkill({ label }: { label: string }): JSX.Element {
  return (
    <span className="cb-bubble-skill" data-part="bubble-skill">
      {label}
    </span>
  );
}

/** A user message (§6.16.6): right-aligned `selected` bubble, at most 75% of the thread. */
export function UserBubble({
  text,
  attachments,
  queued,
  skill,
  details,
}: UserBubbleProps): JSX.Element {
  return (
    <div className="cb-user-msg">
      {attachments}
      <div className="cb-bubble" data-part="bubble" data-queued={queued ? "true" : undefined}>
        {skill !== undefined ? <BubbleSkill label={skill} /> : null}
        {text}
      </div>
      {details !== undefined ? (
        <div className="cb-bubble-details" data-part="bubble-details">
          {details}
        </div>
      ) : null}
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
  onImageError,
}: {
  items: BubbleAttachment[];
  onOpen?(id: string): void;
  /** A thumbnail failed to load (the caller may refresh the session and change `src`). */
  onImageError?(id: string): void;
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
                <img
                  src={a.src}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  {...(onImageError ? { onError: () => onImageError(a.id) } : {})}
                />
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
