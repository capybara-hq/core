import { type JSX, useId, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../display/markdown";
import { Icon } from "../icons/icon";
import { useDesignLocale, useDesignT } from "../provider";
import { Cursor } from "./prose";

export type ThinkingRowProps = {
  /** Thinking time in seconds (rounded for display); null when unknown. */
  seconds: number | null;
  /** The thinking text, Markdown. */
  text: string;
  /**
   * The model is thinking now: "Thinking · N s" and the text's last lines streaming under it; no
   * spinner (a single live step says its state in words, §6.16.5) and no toggle until it ends.
   */
  live?: boolean;
  /** Starts expanded (finished rows only). */
  defaultOpen?: boolean;
  /** Drawn inside a process rail: no left rule on the body, prose-small text. */
  inRail?: boolean;
};

/**
 * A live thinking text's tail (§6.16.5): the rendered Markdown in the secondary text style, held
 * to its last three lines; once it is cut, its top line fades out.
 */
function ThinkingTail({ text }: { text: string }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  // measured after each render: the text grows with every delta
  useLayoutEffect(() => {
    const b = box.current;
    const i = inner.current;
    if (b === null || i === null) return;
    const cut = i.offsetHeight > b.clientHeight + 1;
    setClipped((was) => (was === cut ? was : cut));
  });
  return (
    <div
      ref={box}
      className="cb-thinking-tail"
      data-part="thinking-tail"
      data-clipped={clipped ? "true" : undefined}
    >
      <div ref={inner}>
        <Markdown text={text} tail={<Cursor />} />
      </div>
    </div>
  );
}

/** A thinking row (§6.16.5): a tool line "Thought for N seconds" that opens the thinking text. */
export function ThinkingRow({
  seconds,
  text,
  live,
  defaultOpen,
  inRail,
}: ThinkingRowProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const [open, setOpen] = useState(defaultOpen === true);
  const id = useId();
  const n = seconds === null ? null : Math.max(0, Math.round(seconds));
  if (live) {
    return (
      <div className="cb-thinking-row" data-live="true" data-in-rail={inRail ? "true" : undefined}>
        <div className="cb-tool-line" data-part="tool-line">
          <span className="cb-tool-label">
            {t("conv.thinking")}
            {n === null ? null : (
              // a ticking count: hidden from assistive technology so the thread does not chatter
              <span className="cb-faint" aria-hidden="true">
                {` · ${t("conv.seconds").replace("{n}", String(n))}`}
              </span>
            )}
          </span>
        </div>
        {text === "" ? null : <ThinkingTail text={text} />}
      </div>
    );
  }
  const title =
    n === null
      ? t("conv.thoughtUnknown")
      : n === 1 && locale === "en"
        ? t("conv.thoughtFor1")
        : t("conv.thoughtFor").replace("{n}", String(n));
  if (text === "") {
    return (
      <div className="cb-thinking-row" data-in-rail={inRail ? "true" : undefined}>
        <div className="cb-tool-line" data-part="tool-line">
          <span className="cb-tool-label">{title}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="cb-thinking-row" data-in-rail={inRail ? "true" : undefined}>
      <button
        type="button"
        className="cb-tool-line"
        data-part="tool-line"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cb-tool-label">{title}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open ? (
        <div id={id} className="cb-thinking-body" data-part="thinking-body">
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  );
}
