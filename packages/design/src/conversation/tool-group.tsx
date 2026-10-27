import { type JSX, type ReactNode, useId, useState } from "react";
import { Icon } from "../icons/icon";
import { useDesignLocale } from "../provider";
import { Spinner } from "./prose";
import { elapsed, summaryParts } from "./tool-copy";
import { hasDetail, ToolBox, ToolDetail, ToolLabel, ToolRow, type ToolRowData } from "./tool-row";

export type ToolGroupProps = {
  /** Consecutive calls (one call renders as a single tool line). */
  rows: ToolRowData[];
  /** Controlled open state; a running group is always open. */
  open?: boolean;
  onToggle?(): void;
  /** Rows open at first (uncontrolled). */
  defaultOpenRows?: string[];
  onViewAll?(rowId: string): void;
  onCopy?(rowId: string): void;
  /** The clock for running rows (the caller re-renders each second). */
  now?: number;
  /** Replaces the rows inside the box. */
  children?: ReactNode;
};

const isRunning = (r: ToolRowData) => r.status === "running" || r.status === "pending";

/** Consecutive tool calls (§6.16.8): one line for one call, else a summary over a tool box. */
export function ToolGroup({
  rows,
  open,
  onToggle,
  defaultOpenRows,
  onViewAll,
  onCopy,
  now,
  children,
}: ToolGroupProps): JSX.Element {
  const locale = useDesignLocale();
  const [own, setOwn] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set(defaultOpenRows));
  const id = useId();
  const toggle = () => {
    setAnimate(true);
    if (open === undefined) setOwn((o) => !o);
    onToggle?.();
  };
  const rowCallbacks = (rowId: string) => ({
    ...(onViewAll ? { onViewAll: () => onViewAll(rowId) } : {}),
    ...(onCopy ? { onCopy: () => onCopy(rowId) } : {}),
  });

  const single = rows.length === 1 ? rows[0] : undefined;
  if (single) {
    const isOpen = open ?? own;
    const expandable = hasDetail(single);
    const running = isRunning(single);
    const label = (
      <>
        {running ? <Spinner /> : null}
        <ToolLabel row={single} />
        {running && single.startedAt !== undefined ? (
          <span className="cb-faint">
            {` · ${elapsed((now ?? Date.now()) - single.startedAt, locale)}`}
          </span>
        ) : null}
      </>
    );
    return (
      <div className="cb-tool-group" data-single="true">
        {expandable ? (
          <button
            type="button"
            className="cb-tool-line"
            data-part="tool-line"
            aria-expanded={isOpen}
            aria-controls={isOpen ? id : undefined}
            onClick={toggle}
          >
            {label}
            <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
          </button>
        ) : (
          <div className="cb-tool-line" data-part="tool-line">
            {label}
          </div>
        )}
        {expandable && isOpen ? (
          <ToolBox>
            <ToolDetail row={single} id={id} animate={animate} {...rowCallbacks(single.id)} />
          </ToolBox>
        ) : null}
      </div>
    );
  }

  const running = rows.some(isRunning);
  const isOpen = running || (open ?? own);
  const parts = summaryParts(rows, locale).map((p, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: the runs are positional
      key={i}
      className={p.tone ? `cb-${p.tone === "fail" ? "fail-word" : p.tone}` : undefined}
      data-part={p.part}
    >
      {p.text}
    </span>
  ));
  const box = isOpen ? (
    <ToolBox>
      {children ??
        rows.map((r) => (
          <ToolRow
            key={r.id}
            row={r}
            open={openRows.has(r.id)}
            onToggle={() =>
              setOpenRows((s) => {
                const next = new Set(s);
                if (!next.delete(r.id)) next.add(r.id);
                return next;
              })
            }
            {...rowCallbacks(r.id)}
            {...(now === undefined ? {} : { now })}
          />
        ))}
    </ToolBox>
  ) : null;
  return (
    <div className="cb-tool-group">
      {running ? (
        <div className="cb-tool-line" data-part="tool-line">
          <Spinner />
          <span className="cb-tool-label">{parts}</span>
        </div>
      ) : (
        <button
          type="button"
          className="cb-tool-line"
          data-part="tool-line"
          aria-expanded={isOpen}
          aria-controls={isOpen ? id : undefined}
          onClick={toggle}
        >
          <span className="cb-tool-label">{parts}</span>
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
        </button>
      )}
      {box ? (
        <div id={id} className="cb-expand" data-animate={animate ? "true" : undefined}>
          {box}
        </div>
      ) : null}
    </div>
  );
}
