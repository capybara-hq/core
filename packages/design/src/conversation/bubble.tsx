import { type JSX, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { isSafeAttachmentHref } from "../display/attachments";
import { useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

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
  /**
   * Who sent the message when it is not the person: another agent (a parent's message in a
   * sub-agent's transcript, agent map spec §9.4). Shown above the bubble as "来自 <sender>".
   */
  sender?: string;
  /** A long message starts open (uncontrolled; the reference set's `expanded` state). */
  defaultExpanded?: boolean;
  /**
   * The reference set only: the text counts as taller than the clamp before it is measured
   * (jsdom lays nothing out).
   */
  referenceLong?: boolean;
};

/** The clamp of a long message in prose lines (`layout.bubble-clamp` = 8 × `type.prose.line`). */
const CLAMP_LINES = 8;
/**
 * What one prose line of a bubble holds, in width units (a CJK or full-width character is 1, any
 * other 0.5): the bubble is at most 75% of the 720 column less its padding, about 516 px, and a
 * 15 px CJK character is about 15 px wide.
 */
const LINE_UNITS = 34;

/**
 * Whether a message likely runs past the clamp, from its text alone: the server render and
 * hydration cannot measure, so a long message is drawn folded (the fade and "展开") from the
 * start and the client's measurement then corrects it, instead of the line popping in after
 * hydration (AC4 fix round 1). Counts the hard lines and estimates each one's wrapping.
 */
export function bubbleLooksLong(text: string): boolean {
  let lines = 0;
  for (const line of text.split("\n")) {
    let units = 0;
    for (const ch of line) units += /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : 0.5;
    lines += Math.max(1, Math.ceil(units / LINE_UNITS));
    if (lines > CLAMP_LINES) return true;
  }
  return false;
}

/** The skill chip inside a bubble (§6.16.6): the composer's chip without its remove button. */
export function BubbleSkill({ label }: { label: string }): JSX.Element {
  return (
    <span className="cb-bubble-skill" data-part="bubble-skill">
      {label}
    </span>
  );
}

/**
 * A user message (§6.16.6): right-aligned `selected` bubble, at most 75% of the thread. A message
 * taller than `layout.bubble-clamp` (eight prose lines) is clamped with its last line fading out,
 * and "展开" / "Show more" under it opens it in full ("收起" / "Show less" folds it back); the
 * attachments above and the skill chip on its first line always show.
 */
export function UserBubble({
  text,
  attachments,
  queued,
  skill,
  details,
  sender,
  defaultExpanded,
  referenceLong,
}: UserBubbleProps): JSX.Element {
  const t = useDesignT();
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Per bubble and local to the view (acceptance item AC4): never persisted.
  const [expanded, setExpanded] = useState(defaultExpanded === true);
  // first guessed from the text (the server render's answer), then measured
  const [overflows, setOverflows] = useState(() => referenceLong === true || bubbleLooksLong(text));
  // The toggle shows only when the clamp (`layout.bubble-clamp`, eight prose lines) hides something:
  // measured, and again on resize; an expanded message keeps it so it can fold back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text or chip must be measured again
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    const measure = () =>
      setOverflows(referenceLong === true || el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, skill, expanded, referenceLong]);
  return (
    <div className="cb-user-msg" data-cap-part="message.user">
      {sender !== undefined ? (
        <div className="cb-bubble-sender" data-part="bubble-sender">
          {fillCopy(t("bubble.from"), { name: sender })}
        </div>
      ) : null}
      {attachments}
      <div
        className="cb-bubble"
        data-part="bubble"
        data-cap-part="message.user.bubble"
        data-queued={queued ? "true" : undefined}
      >
        <div
          ref={bodyRef}
          id={bodyId}
          className="cb-bubble-body"
          data-part="bubble-body"
          data-expanded={expanded ? "true" : "false"}
          data-overflows={overflows && !expanded ? "true" : undefined}
        >
          {skill !== undefined ? <BubbleSkill label={skill} /> : null}
          {text}
        </div>
      </div>
      {expanded || overflows ? (
        <button
          type="button"
          className="cb-link-btn cb-bubble-more"
          data-part="bubble-more"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? t("bubble.less") : t("bubble.more")}
        </button>
      ) : null}
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
