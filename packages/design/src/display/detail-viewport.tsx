import {
  type JSX,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

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

export type DetailViewportLabels = { expand?: string; collapse?: string };

/**
 * The tool detail viewport (§6.16.9 "Detail viewport"): one scroll box of a tool's detail (a diff,
 * an output, the IN command or inputs, a prompt), at most `layout.tool-detail` high. When its
 * content overflows, an expand icon button in its top corner (「展开」 / "Expand", then 「收起」 /
 * "Collapse", `aria-expanded`) grows it to the tall cap (70% of the viewport height), where it
 * still scrolls. `live` follows the tail in both heights.
 */
export function DetailViewport({
  as = "div",
  className,
  part,
  live = false,
  change,
  labels,
  children,
}: {
  /** The scroll element's tag: `pre` for an output, `div` for the rest. */
  as?: "div" | "pre";
  /** The scroll element's own class (its ground, padding and type). */
  className: string;
  /** The scroll element's `data-part`. */
  part: string;
  /** The content is still growing: follow its tail (`data-live` on the scroll element). */
  live?: boolean;
  /** What grows while `live` (re-runs the tail-follow). */
  change?: unknown;
  /** The control's names, when a caller overrides the design copy. */
  labels?: DetailViewportLabels;
  children: ReactNode;
}): JSX.Element {
  const t = useDesignT();
  const ref = useRef<HTMLElement | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const id = useId();
  const onScroll = useTailFollow(ref, live, `${String(change)}:${expanded}`);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = el.scrollHeight > el.clientHeight + 1;
    setOverflow((o) => (o === next ? o : next));
    // the control stands clear of a classic scrollbar
    const bar = Math.max(0, el.offsetWidth - el.clientWidth);
    wrap.current?.style.setProperty("--cb-viewport-bar", `${bar}px`);
  }, []);
  // every render may have grown the content
  useLayoutEffect(measure);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  const Tag = as;
  // an expanded box keeps its control when its content fits the tall cap, so it can be folded
  const control = overflow || expanded;
  return (
    <div
      ref={wrap}
      className="cb-viewport"
      data-part="detail-viewport"
      data-expanded={expanded ? "true" : undefined}
    >
      <Tag
        ref={ref as RefObject<HTMLDivElement & HTMLPreElement>}
        id={id}
        className={className}
        data-part={part}
        data-viewport=""
        data-expanded={expanded ? "" : undefined}
        data-live={live ? "" : undefined}
        onScroll={onScroll}
      >
        {children}
      </Tag>
      {control ? (
        <IconButton
          className="cb-viewport-toggle"
          part="detail-expand"
          density="dense"
          label={
            expanded
              ? (labels?.collapse ?? t("tool.detailCollapse"))
              : (labels?.expand ?? t("tool.detailExpand"))
          }
          icon={<Icon name={expanded ? "minimize-2" : "maximize-2"} size={12} />}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((e) => !e)}
        />
      ) : null}
    </div>
  );
}
