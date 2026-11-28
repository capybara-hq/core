import {
  Fragment,
  type JSX,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/button";
import { isSafeAttachmentHref } from "../display/attachments";
import { Avatar } from "../display/avatar";
import type { PersonLike } from "../display/person-name";
import { Icon } from "../icons/icon";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import type { ComposerSegment, ComposerTokenData } from "./composer-editor/segments";
import { InlineToken, type InlineTokenAction, skillText } from "./composer-editor/token";
import { fillCopy } from "./tool-copy";

/**
 * The message is `text`, or `segments` (text runs and inline tokens, composer inline tokens spec
 * §1), never both: each token is a read-only {@link InlineToken} in the sentence. The text runs
 * keep the bubble's own `pre-wrap` treatment (the bubble draws plain text, not markdown), so
 * tokens interleave as inline boxes. The skill chip still comes first.
 */
export type UserBubbleProps = {
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
  /**
   * Who wrote it (spec §6.16.6): a 24 circle avatar at the bubble's end side; `showName` puts the
   * name above the bubble (a shared conversation's trajectory, where the writer is not the viewer).
   * Absent, nothing is drawn.
   */
  author?: PersonLike & { showName?: boolean };
  /** A long message starts open (uncontrolled; the reference set's `expanded` state). */
  defaultExpanded?: boolean;
  /**
   * The reference set only: the text counts as taller than the clamp before it is measured
   * (jsdom lays nothing out).
   */
  referenceLong?: boolean;
  /**
   * What a token of `segments` opens: a referenced conversation's page, a library file's preview.
   * Such a token is a link or a button (focusable, its focus ring); the others stay marks.
   */
  tokenAction?(token: ComposerTokenData): InlineTokenAction | undefined;
} & ({ text: string; segments?: never } | { text?: never; segments: ComposerSegment[] });

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

/** The segments' plain text, what the clamp's guess and the empty check read (a token is its label). */
function segmentsText(segments: ComposerSegment[]): string {
  return segments
    .map((x) => (typeof x === "string" ? x : x.kind === "skill" ? skillText(x.label) : x.label))
    .join("");
}

/** The `action` prop of a bubble's token, or none. */
function actionOf(
  of: UserBubbleProps["tokenAction"],
  token: ComposerTokenData,
): { action?: InlineTokenAction } {
  const action = of?.(token);
  return action === undefined ? {} : { action };
}

/** The skill chip inside a bubble (§6.16.6): the composer's chip without its remove button. */
export function BubbleSkill({ label }: { label: string }): JSX.Element {
  return (
    <span className="cb-bubble-skill" data-part="bubble-skill">
      {label}
    </span>
  );
}

/** The bubble, with the author's 40 circle at its end side when it has one (spec §6.16.6). */
function BubbleRow({
  author,
  children,
}: {
  author: UserBubbleProps["author"];
  children: ReactNode;
}): JSX.Element {
  if (!author) return <>{children}</>;
  return (
    <div className="cb-bubble-row" data-part="bubble-row">
      {children}
      <Avatar
        shape="circle"
        size={40}
        name={author.initialFrom ?? author.name}
        value={author.avatarUrl ? { kind: "image", src: author.avatarUrl } : null}
      />
    </div>
  );
}

/**
 * A user message (§6.16.6): right-aligned `selected` bubble, at most 75% of the thread. A message
 * taller than `layout.bubble-clamp` (eight prose lines) is clamped with its last line fading out,
 * and "展开" / "Show more" under it opens it in full ("收起" / "Show less" folds it back); the
 * attachments above and the skill chip on its first line always show.
 */
export function UserBubble({
  text: textProp,
  segments,
  attachments,
  queued,
  skill,
  details,
  sender,
  author,
  defaultExpanded,
  referenceLong,
  tokenAction,
}: UserBubbleProps): JSX.Element {
  const t = useDesignT();
  const text = segments ? segmentsText(segments) : (textProp ?? "");
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
  }, [text, segments, skill, expanded, referenceLong]);
  return (
    <div className="cb-user-msg" data-cap-part="message.user">
      {sender !== undefined ? (
        <div className="cb-bubble-sender" data-part="bubble-sender">
          {fillCopy(t("bubble.from"), { name: sender })}
        </div>
      ) : null}
      {author?.showName ? (
        <div className="cb-bubble-author-name" data-part="bubble-author-name">
          {author.name}
        </div>
      ) : null}
      {attachments}
      {/* An attachment-only message (an image sent without words) draws no empty bubble */}
      {text.trim() === "" && skill === undefined ? null : (
        <BubbleRow author={author}>
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
              {segments
                ? segments.map((seg, i) =>
                    typeof seg === "string" ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list
                      <Fragment key={i}>{seg}</Fragment>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list
                      <InlineToken key={i} token={seg} {...actionOf(tokenAction, seg)} />
                    ),
                  )
                : text}
            </div>
          </div>
        </BubbleRow>
      )}
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
  /** `conversation`: a referenced conversation, a link chip to `href` (§6.16.6). */
  kind: "image" | "file" | "conversation";
  /** The file's name, or the conversation's title (empty: "Untitled conversation"). */
  name: string;
  /** Type badge (e.g. "PDF"). */
  type?: string;
  /** Formatted size. */
  size?: string;
  /** Thumbnail source of an image (http(s) or same-origin path; anything else is not loaded). */
  src?: string;
  /** `false`: no download button for this file (a resource mention, not an upload). */
  downloadable?: boolean;
  /** A conversation's page (`/chat/<id>`), opened through the DesignProvider's `link`. */
  href?: string;
};

/** A referenced conversation in a sent message (§6.16.6): a link chip, no download button. */
function ConversationChip({ item }: { item: BubbleAttachment }): JSX.Element {
  const t = useDesignT();
  const Link = useDesignLink();
  const title = item.name || t("attachment.conversationUntitled");
  const body = (
    <>
      <span className="cb-attachment-icon" data-part="attachment-icon">
        <Icon name="chats" size={14} />
      </span>
      <span className="cb-bubble-file-name" data-part="attachment-name">
        {title}
      </span>
    </>
  );
  if (item.href === undefined || !isSafeAttachmentHref(item.href)) {
    return (
      <span
        className="cb-bubble-file cb-bubble-conv"
        data-part="attachment"
        data-kind="conversation"
        title={title}
      >
        {body}
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      className="cb-bubble-file cb-bubble-conv"
      data-part="attachment"
      data-kind="conversation"
      aria-label={fillCopy(t("attachment.openConversation"), { title })}
    >
      {body}
      <LinkPendingMark />
    </Link>
  );
}

/**
 * Attachments of a sent message: image thumbnails, then file chips, each opening on click, and
 * referenced conversations as link chips (in the page's order among the files). With
 * `onDownload`, each downloadable file chip has a download icon button after it (its own button:
 * it never opens the file).
 */
export function BubbleAttachments({
  items,
  onOpen,
  onDownload,
  onImageError,
  form,
}: {
  items: BubbleAttachment[];
  onOpen?(id: string): void;
  onDownload?(id: string): void;
  /** A thumbnail failed to load (the caller may refresh the session and change `src`). */
  onImageError?(id: string): void;
  /** The reference set and catalog only: draw the compact form in a wide window. */
  form?: "compact";
}): JSX.Element {
  const t = useDesignT();
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind !== "image");
  return (
    <div className="cb-bubble-atts" data-form={form}>
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
      {files.map((a) => {
        if (a.kind === "conversation") return <ConversationChip key={a.id} item={a} />;
        const chip = (
          <button
            type="button"
            className="cb-bubble-file"
            data-part="attachment"
            onClick={() => onOpen?.(a.id)}
          >
            {a.type ? <span className="cb-type-badge">{a.type}</span> : null}
            <span className="cb-bubble-file-name">{a.name}</span>
            {a.size ? <span className="cb-muted">{a.size}</span> : null}
          </button>
        );
        if (!onDownload || a.downloadable === false) return <Fragment key={a.id}>{chip}</Fragment>;
        return (
          <div key={a.id} className="cb-bubble-file-row" data-part="attachment-row">
            {chip}
            <IconButton
              density="dense"
              icon={<Icon name="download" size={14} />}
              label={t("files.download")}
              onClick={() => onDownload(a.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
