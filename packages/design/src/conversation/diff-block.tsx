import type { JSX, ReactNode } from "react";
import { useDesignLocale, useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

export type DiffLineData = { kind: "ctx" | "add" | "del"; text: string };
export type DiffHunk = { oldStart: number; newStart: number; lines: DiffLineData[] };
/** A line diff as the kernel's `tool_result.view` carries it. */
export type DiffData = {
  hunks: DiffHunk[];
  /** Hunks were left out (`TOOL_VIEW_DIFF_MAX_LINES`) or not computed. */
  truncated: boolean;
  /** Lines of the whole diff when known ("showing first N / M lines"). */
  totalLines?: number;
};

const SIGN = { ctx: " ", add: "+", del: "−" } as const;

/** The expanded form of an edit (§6.16.10): numbered lines tinted by kind, no colored text. */
export function DiffBlock({
  diff,
  onViewAll,
}: {
  diff: DiffData;
  onViewAll?(): void;
}): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const rows: ReactNode[] = [];
  let shown = 0;
  diff.hunks.forEach((h, hi) => {
    const at = `${h.oldStart}:${h.newStart}`;
    if (hi > 0) rows.push(<div key={`gap:${at}`} className="cb-diff-gap" aria-hidden="true" />);
    let o = h.oldStart;
    let n = h.newStart;
    h.lines.forEach((l) => {
      const num = l.kind === "del" ? o : n;
      if (l.kind !== "add") o++;
      if (l.kind !== "del") n++;
      shown++;
      rows.push(
        <div
          key={`${l.kind}:${num}`}
          className="cb-diff-line"
          data-part="diff-line"
          data-kind={l.kind}
        >
          <span className="cb-diff-gutter" data-part="diff-gutter">
            {num}
          </span>
          <span className="cb-diff-sign" aria-hidden={l.kind === "ctx" ? true : undefined}>
            {SIGN[l.kind]}
          </span>
          <span className="cb-diff-text">{l.text}</span>
        </div>,
      );
    });
  });
  const num = (v: number) => v.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
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
