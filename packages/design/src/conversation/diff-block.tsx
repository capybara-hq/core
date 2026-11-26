import { type JSX, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { useDesignLocale, useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

export type DiffLineData = { kind: "ctx" | "add" | "del"; text: string };
export type DiffHunk = { oldStart: number; newStart: number; lines: DiffLineData[] };
/** A line diff as the kernel's `tool_result.view` carries it. */
export type DiffData = {
  hunks: DiffHunk[];
  /**
   * Lines were left out (`TOOL_VIEW_DIFF_MAX_LINES`) or not computed. A live block keeps the last
   * lines instead (the live tail), so there the left-out lines are the earlier ones.
   */
  truncated: boolean;
  /** Lines of the whole diff when known ("showing first N / M lines", "N earlier lines"). */
  totalLines?: number;
};

/**
 * The live forms of a streaming call's block (§6.16.10 Live). `gutter: "pending"` is the edit
 * form (no numbers yet, footer "Line numbers after it runs"); `preview` the writing form (footer
 * "Preview"); `pending` the base lines past the aligned part, drawn as one line.
 */
export type DiffBlockLive = {
  gutter?: "numbers" | "pending";
  pending?: number;
  preview?: boolean;
};

/**
 * The most characters of one line the block draws (the kernel's `TOOL_VIEW_LINE_MAX_CHARS`): a
 * 1 MB line never reaches the page whole; the line's ellipsis shows it goes on.
 */
export const DIFF_LINE_MAX_CHARS = 2000;

/** `text` cut at {@link DIFF_LINE_MAX_CHARS}, never inside a surrogate pair. */
export function cutDiffLine(text: string): string {
  if (text.length <= DIFF_LINE_MAX_CHARS) return text;
  const end = DIFF_LINE_MAX_CHARS;
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

const SIGN = { ctx: " ", add: "+", del: "−" } as const;

/**
 * Keeps a scrolling viewport at its bottom while `active` and the reader is there: a scroll up
 * stops following, a scroll back to the bottom resumes it (§6.16.10 tail-follow). `change`
 * is what grows (the lines drawn).
 */
export function useTailFollow(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  change: unknown,
): () => void {
  const follow = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `change` re-runs it as the text grows
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el || !follow.current) return;
    el.scrollTop = el.scrollHeight;
  }, [active, change, ref]);
  return () => {
    const el = ref.current;
    if (!el) return;
    follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  };
}

/** The expanded form of an edit (§6.16.10): numbered lines tinted by kind, no colored text. */
export function DiffBlock({
  diff,
  onViewAll,
  live = false,
  gutter = "numbers",
  pending = 0,
  preview = false,
  caret = live,
}: {
  diff: DiffData;
  onViewAll?(): void;
  /** The model is still writing the input: caret, tail-follow, the live forms (§6.16.10). */
  live?: boolean;
  /**
   * The caret on the last line (default: while `live`). Off for a live block whose input is
   * complete (the logged call before its result): the live forms stay, nothing is being written.
   */
  caret?: boolean;
} & DiffBlockLive): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const view = useRef<HTMLDivElement>(null);
  const num = (v: number) => v.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  const count = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
  // The live tail keeps the last lines: the ones left out come before them.
  const earlier =
    diff.truncated && diff.totalLines !== undefined ? Math.max(0, diff.totalLines - count) : 0;
  // every change of what the viewport holds keeps a reader at the bottom there
  const onScroll = useTailFollow(view, live, `${count}:${pending}:${earlier}`);
  const rows: ReactNode[] = [];
  let shown = 0;
  diff.hunks.forEach((h, hi) => {
    const at = `${h.oldStart}:${h.newStart}`;
    if (hi > 0) rows.push(<div key={`gap:${at}`} className="cb-diff-gap" aria-hidden="true" />);
    let o = h.oldStart;
    let n = h.newStart;
    h.lines.forEach((l) => {
      const lineNo = l.kind === "del" ? o : n;
      if (l.kind !== "add") o++;
      if (l.kind !== "del") n++;
      shown++;
      const last = live && caret && shown === count;
      rows.push(
        // Keyed by kind and number alone: the live tail moves the first hunk's starts each frame,
        // and a key with them would remount every line (and lose a selection). Numbers grow
        // across hunks, and the edit form counts its removed and added lines apart from 0.
        <div
          key={`${l.kind}:${lineNo}`}
          className="cb-diff-line"
          data-part="diff-line"
          data-kind={l.kind}
        >
          <span className="cb-diff-gutter" data-part="diff-gutter">
            {gutter === "pending" ? "" : lineNo}
          </span>
          <span className="cb-diff-sign" aria-hidden={l.kind === "ctx" ? true : undefined}>
            {SIGN[l.kind]}
          </span>
          <span className="cb-diff-text">{cutDiffLine(l.text)}</span>
          {/* after the text, never shrunk: an over-wide line takes the ellipsis, the caret stays */}
          {last ? (
            <span className="cb-cursor cb-diff-caret" data-part="diff-caret" aria-hidden="true" />
          ) : null}
        </div>,
      );
    });
  });
  if (!live) {
    return (
      <div className="cb-diff" data-part="diff">
        {rows}
        {diff.truncated ? (
          <div className="cb-diff-cut" data-part="diff-cut">
            <span>
              {diff.totalLines === undefined
                ? fillCopy(t("tool.diffCutNoTotal"), { n: num(shown) })
                : fillCopy(t("tool.diffCut"), { n: num(shown), m: num(diff.totalLines) })}
              {/* "· View all" reads as one run with the count, then space.1 to the link. */}
              {onViewAll ? " ·" : null}
            </span>
            {onViewAll ? (
              <button type="button" className="cb-link-btn" onClick={onViewAll}>
                {t("tool.viewAll")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  const collapsed = (part: string, text: string) => (
    <div className="cb-diff-line cb-diff-collapsed" data-part={part}>
      <span className="cb-diff-gutter" />
      <span className="cb-diff-sign" />
      <span className="cb-diff-text">{text}</span>
    </div>
  );
  const foot =
    gutter === "pending" ? t("tool.diffNumbersPending") : preview ? t("tool.diffPreview") : null;
  return (
    <div className="cb-diff-live">
      <div ref={view} className="cb-diff" data-part="diff" data-live="" onScroll={onScroll}>
        {earlier > 0
          ? collapsed("diff-earlier", fillCopy(t("tool.diffEarlier"), { n: num(earlier) }))
          : null}
        {rows}
        {pending > 0
          ? collapsed("diff-pending", fillCopy(t("tool.diffPending"), { n: num(pending) }))
          : null}
      </div>
      {foot ? (
        <div className="cb-diff-foot" data-part="diff-foot">
          {foot}
        </div>
      ) : null}
    </div>
  );
}
