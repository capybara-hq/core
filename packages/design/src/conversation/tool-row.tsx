import { type JSX, type ReactNode, useId, useState } from "react";
import { formatBytes } from "../display/attachments";
import { Icon } from "../icons/icon";
import { useDesignLocale, useDesignT } from "../provider";
import { DiffBlock, type DiffData } from "./diff-block";
import { Spinner } from "./prose";
import { elapsed, fillCopy, rowVerb, type ToolKind } from "./tool-copy";

export type ToolRowData = {
  id: string;
  kind: ToolKind;
  /** The connector's or extension's name ("Acme 工单"); builtins have none. */
  source?: string;
  /** The declared title, else the key; empty for builtins whose verb says it (read, edit). */
  title: string;
  /** The key arguments, in body color. */
  keyArg?: string;
  /** Extra information after " · " ("42 条", "第 1–120 行"). */
  extra?: string;
  /** A shell row's `description` from the model, shown instead of verb and title. */
  description?: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  startedAt?: number;
  durationMs?: number;
  /** Lines added / removed by an edit ("+a −b"). */
  added?: number;
  removed?: number;
  /** The error; its first line is shown after "Failed". */
  error?: string;
  /** The extension whose policy hook denied the call. */
  blockedBy?: string;
  detail?: {
    input?: [string, string][];
    command?: string;
    /** The output, or a prefix of it when `outputBytes` is larger. */
    output?: string;
    /** Size of the whole output (the archive), when `output` may be a prefix. */
    outputBytes?: number;
    /** Size of the prefix shown; defaults to the UTF-8 size of `output`. */
    outputShownBytes?: number;
    /** The full error text of a failure (shown in the output box). */
    errorText?: string;
    diff?: DiffData;
  };
};

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** "verb source: title key · extra" plus the failure, one line with an ellipsis. */
export function ToolLabel({ row }: { row: ToolRowData }): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const lead =
    row.kind === "command" && row.description
      ? row.description
      : [rowVerb(row.kind, locale), row.source ? `${row.source}: ${row.title}` : row.title]
          .filter((s) => s !== "")
          .join(" ");
  const extra =
    row.added !== undefined || row.removed !== undefined
      ? `+${row.added ?? 0} −${row.removed ?? 0}`
      : row.extra;
  const reason = row.blockedBy
    ? fillCopy(t("tool.blockedBy"), { name: row.blockedBy })
    : row.error?.split("\n")[0]?.trim();
  return (
    <span className="cb-tool-label" data-part="tool-label">
      {lead}
      {row.keyArg ? (
        <>
          {" "}
          <span className="cb-ink" data-part="key-arg">
            {row.keyArg}
          </span>
        </>
      ) : null}
      {extra ? <span className="cb-faint">{` · ${extra}`}</span> : null}
      {row.status === "failed" ? (
        <>
          {" "}
          <span className="cb-fail-word" data-part="fail-word">
            {t("tool.failed")}
          </span>
          {reason ? <span className="cb-muted">{` · ${reason}`}</span> : null}
        </>
      ) : null}
      {row.status === "cancelled" ? (
        <span className="cb-muted">{` · ${t("tool.cancelled")}`}</span>
      ) : null}
    </span>
  );
}

export function hasDetail(row: ToolRowData): boolean {
  const d = row.detail;
  return (
    d !== undefined &&
    (d.input !== undefined ||
      d.command !== undefined ||
      d.output !== undefined ||
      d.errorText !== undefined ||
      d.diff !== undefined)
  );
}

/** The expanded detail: inputs, `$ command`, output, footer; or the diff of an edit. */
export function ToolDetail({
  row,
  id,
  onViewAll,
  onCopy,
  animate,
}: {
  row: ToolRowData;
  id?: string;
  onViewAll?(): void;
  onCopy?(): void;
  /** Grow in over `motion.expand` (set when the viewer opened it, not on first paint). */
  animate?: boolean;
}): JSX.Element | null {
  const t = useDesignT();
  const d = row.detail;
  if (!d) return null;
  if (d.diff) {
    return (
      <div id={id} className="cb-tool-diff cb-expand" data-animate={animate ? "true" : undefined}>
        <DiffBlock diff={d.diff} {...(onViewAll ? { onViewAll } : {})} />
      </div>
    );
  }
  const out = row.status === "failed" ? (d.errorText ?? d.output) : d.output;
  const shownBytes = d.outputShownBytes ?? (d.output === undefined ? 0 : utf8(d.output));
  const large = d.outputBytes !== undefined && d.outputBytes > shownBytes;
  const foot: ReactNode[] = [];
  if (large) {
    foot.push(
      <span key="size">
        {fillCopy(t("tool.largeOutput"), {
          total: formatBytes(d.outputBytes ?? 0),
          shown: formatBytes(shownBytes),
        })}
      </span>,
    );
    if (onViewAll) {
      foot.push(
        <button key="all" type="button" className="cb-link-btn" onClick={onViewAll}>
          {t("tool.viewAll")}
        </button>,
      );
    }
  } else {
    if (row.durationMs !== undefined) {
      foot.push(
        <span key="dur">
          {fillCopy(t("tool.duration"), { n: (row.durationMs / 1000).toFixed(1) })}
        </span>,
      );
    }
    if (onCopy && out !== undefined) {
      foot.push(
        <button key="copy" type="button" className="cb-link-btn" onClick={onCopy}>
          {t("tool.copyOutput")}
        </button>,
      );
    }
  }
  return (
    <div
      id={id}
      className="cb-tool-detail cb-expand"
      data-part="tool-detail"
      data-animate={animate ? "true" : undefined}
    >
      {d.input && d.input.length > 0 ? (
        <div className="cb-kv" data-part="kv">
          {d.input.map(([k, v], i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: input keys may repeat; order is stable
            <span key={i} className="cb-kv-pair">
              <span className="cb-kv-key" data-part="kv-key">
                {k}
              </span>
              <span className="cb-kv-value" data-part="kv-value">
                {v}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {d.command !== undefined ? (
        <div className="cb-tool-command" data-part="tool-command">
          <span className="cb-faint">$</span> {d.command}
        </div>
      ) : null}
      {out !== undefined ? (
        <pre className="cb-tool-output" data-part="tool-output">
          {out}
        </pre>
      ) : null}
      {foot.length > 0 ? (
        <div className="cb-tool-footer" data-part="tool-footer">
          {foot}
        </div>
      ) : null}
    </div>
  );
}

export type ToolRowProps = {
  row: ToolRowData;
  /** Controlled open state; uncontrolled when omitted. */
  open?: boolean;
  onToggle?(): void;
  onViewAll?(): void;
  onCopy?(): void;
  /** The clock for the running elapsed time (the caller re-renders each second). */
  now?: number;
};

/** One call inside a tool box (§6.16.9). */
export function ToolRow({
  row,
  open,
  onToggle,
  onViewAll,
  onCopy,
  now,
}: ToolRowProps): JSX.Element {
  const locale = useDesignLocale();
  const [own, setOwn] = useState(false);
  const [animate, setAnimate] = useState(false);
  const id = useId();
  const isOpen = open ?? own;
  const expandable = hasDetail(row);
  const running = row.status === "running" || row.status === "pending";
  const end = running ? (
    row.startedAt !== undefined ? (
      <span className="cb-tool-end cb-faint">
        {elapsed((now ?? Date.now()) - row.startedAt, locale)}
      </span>
    ) : null
  ) : expandable ? (
    <span className="cb-tool-end">
      <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
    </span>
  ) : null;
  const inner = (
    <>
      {running ? <Spinner /> : null}
      <ToolLabel row={row} />
      {end}
    </>
  );
  return (
    <div className="cb-tool-item" data-open={expandable && isOpen ? "true" : undefined}>
      {expandable ? (
        <button
          type="button"
          className="cb-tool-row"
          data-part="tool-row"
          data-status={row.status}
          aria-expanded={isOpen}
          aria-controls={isOpen ? id : undefined}
          onClick={() => {
            setAnimate(true);
            if (open === undefined) setOwn((o) => !o);
            onToggle?.();
          }}
        >
          {inner}
        </button>
      ) : (
        <div className="cb-tool-row" data-part="tool-row" data-status={row.status}>
          {inner}
        </div>
      )}
      {expandable && isOpen ? (
        <ToolDetail
          row={row}
          id={id}
          animate={animate}
          {...(onViewAll ? { onViewAll } : {})}
          {...(onCopy ? { onCopy } : {})}
        />
      ) : null}
    </div>
  );
}

/** The tool box (§6.16.8): `panel` ground, radius `md`, rows divided by `line-soft`. */
export function ToolBox({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="cb-tool-box" data-part="tool-box">
      {children}
    </div>
  );
}
