import { type JSX, type ReactNode, useId, useState } from "react";
import { formatBytes } from "../display/attachments";
import { formatDuration } from "../display/duration";
import { Icon } from "../icons/icon";
import { useDesignLocale, useDesignT } from "../provider";
import { useClock } from "./clock";
import { DiffBlock, type DiffData } from "./diff-block";
import { Spinner } from "./prose";
import {
  fillCopy,
  type ToolGuard,
  type ToolKind,
  type ToolNotice,
  type ToolWaiting,
  waitingText,
} from "./tool-copy";

export type ToolRowData = {
  id: string;
  kind: ToolKind;
  /**
   * The bold name (§6.16.9): a builtin's tool name as is ("Bash", "Read"), or the connector's /
   * plugin's display name ("Acme 工单") of a connector or extension tool.
   */
  name: string;
  /** The local tool name of a connector or extension tool, shown in brackets after the name. */
  tool?: string;
  /** The declared title, shown as the row's tooltip (never in the brackets). */
  tooltip?: string;
  /** The key argument preview (first line, cut at {@link KEY_ARG_MAX} with "…"). */
  keyArg?: string;
  /** Extra information after " · " ("42 条", "第 1–120 行"). */
  extra?: string;
  /** A shell row's `description` from the model, shown instead of the key argument. */
  description?: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  /**
   * The live call waits for a person (a pending approval, question or connection): the row shows
   * the waiting word instead of the spinner and the timer (§6.16.9). Ignored once it ends.
   */
  waiting?: ToolWaiting;
  /**
   * Who the call waits for when that is not the viewer: a member's name, or a role ("管理员") for
   * an approval escalated by role; absent = the viewer ("等待你批准").
   */
  waitingFor?: string;
  startedAt?: number;
  durationMs?: number;
  /** Lines added / removed by an edit ("+a −b"). */
  added?: number;
  removed?: number;
  /**
   * A done call a guard refused (the read-before-write check): the row adds the neutral word
   * "已拦下：需先重新读取" / "Blocked: read the file again first" in `muted` (§6.16.9).
   */
  guard?: ToolGuard;
  /**
   * A done call with a protocol notice (the tool was not loaded): the row adds the neutral word
   * "需先加载工具" / "Load the tool first" in `muted` (§6.16.9).
   */
  notice?: ToolNotice;
  /** The error; its first line is shown after "Failed". */
  error?: string;
  /** The extension whose policy hook denied the call. */
  blockedBy?: string;
  /**
   * A link at the row's end (§6.16.9): a background `Bash` call's task, "查看「…」的输出" /
   * "View output of …", which opens the task's output on the right. The row's toggle and the link
   * are two buttons side by side.
   */
  link?: { label: string; onOpen(): void };
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

/** The key argument preview's length before it is cut with "…". */
export const KEY_ARG_MAX = 80;

/** The key argument as the row previews it: its first line, at most {@link KEY_ARG_MAX} characters. */
export function keyArgPreview(s: string): string {
  const lines = s.split("\n");
  const first = lines[0] ?? "";
  const chars = [...first];
  if (chars.length > KEY_ARG_MAX) return `${chars.slice(0, KEY_ARG_MAX).join("")}…`;
  return lines.length > 1 ? `${first}…` : first;
}

/** "**name [tool]** preview · extra" plus the failure, one line with an ellipsis (§6.16.9). */
export function ToolLabel({ row }: { row: ToolRowData }): JSX.Element {
  const t = useDesignT();
  const preview =
    row.kind === "command" && row.description
      ? row.description
      : row.keyArg
        ? keyArgPreview(row.keyArg)
        : undefined;
  const extra =
    row.added !== undefined || row.removed !== undefined
      ? `+${row.added ?? 0} −${row.removed ?? 0}`
      : row.extra;
  const reason = row.blockedBy
    ? fillCopy(t("tool.blockedBy"), { name: row.blockedBy })
    : row.error?.split("\n")[0]?.trim();
  return (
    <span
      className="cb-tool-label"
      data-part="tool-label"
      {...(row.tooltip ? { title: row.tooltip } : {})}
    >
      <span className="cb-tool-name" data-part="tool-name">
        {row.kind === "question"
          ? t("tool.verb.question")
          : row.tool
            ? `${row.name} [${row.tool}]`
            : row.name}
      </span>
      {preview ? (
        <>
          {" "}
          <span data-part="key-arg">{preview}</span>
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
      {row.status === "done" && row.guard ? (
        <span className="cb-muted" data-part="guard-word">
          {` · ${t(`tool.guard.${row.guard}`)}`}
        </span>
      ) : null}
      {row.status === "done" && row.notice ? (
        <span className="cb-muted" data-part="notice-word">
          {` · ${t(`tool.notice.${row.notice}`)}`}
        </span>
      ) : null}
      {row.status === "cancelled" ? (
        <span className="cb-muted">{` · ${t("tool.cancelled")}`}</span>
      ) : null}
    </span>
  );
}

/** The row's link (§6.16.9), a link button after the toggle. */
export function ToolLink({ link }: { link: NonNullable<ToolRowData["link"]> }): JSX.Element {
  return (
    <button
      type="button"
      className="cb-link-btn cb-tool-link"
      data-part="tool-link"
      onClick={link.onOpen}
    >
      {link.label}
    </button>
  );
}

/** The call is live: pending or running (a waiting call is live too). */
export const isLive = (row: ToolRowData): boolean =>
  row.status === "running" || row.status === "pending";

/** The live call waits for a person (§6.16.9): no spinner, no timer, the waiting word. */
export const isWaiting = (row: ToolRowData): boolean => isLive(row) && row.waiting !== undefined;

/** The waiting word of a live call that waits for a person, in `accent` (§6.16.9). */
export function WaitingWord({
  row,
  lead,
}: {
  row: ToolRowData;
  lead?: string;
}): JSX.Element | null {
  const locale = useDesignLocale();
  if (!isWaiting(row) || row.waiting === undefined) return null;
  return (
    <span className="cb-accent-word" data-part="waiting-word">
      {`${lead ?? ""}${waitingText(row.waiting, row.waitingFor, locale)}`}
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
  const locale = useDesignLocale();
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
      foot.push(<span key="dur">{formatDuration(row.durationMs, locale)}</span>);
      // Copy rides on the duration line: a call that never ran (a hook denial) has no footer.
      if (onCopy && out !== undefined) {
        foot.push(
          <button key="copy" type="button" className="cb-link-btn" onClick={onCopy}>
            {t("tool.copyOutput")}
          </button>,
        );
      }
    }
  }
  const hasIn = d.command !== undefined || (d.input !== undefined && d.input.length > 0);
  const hasOut = out !== undefined || foot.length > 0;
  return (
    <div
      id={id}
      className="cb-tool-detail cb-expand"
      data-part="tool-detail"
      data-animate={animate ? "true" : undefined}
    >
      {hasIn ? (
        <IoSection label={t("tool.in")} which="in">
          {d.command !== undefined ? (
            <div className="cb-tool-command" data-part="tool-command">
              <span className="cb-faint">$</span> {d.command}
            </div>
          ) : (
            <div className="cb-kv" data-part="kv">
              {(d.input ?? []).map(([k, v], i) => (
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
          )}
        </IoSection>
      ) : null}
      {hasOut ? (
        <IoSection label={t("tool.out")} which="out">
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
        </IoSection>
      ) : null}
    </div>
  );
}

/** One labelled block of the expanded detail: "IN" / "OUT" beside its body (§6.16.9). */
function IoSection({
  label,
  which,
  children,
}: {
  label: string;
  which: "in" | "out";
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="cb-tool-io" data-part="tool-io" data-io={which}>
      <span className="cb-tool-io-label" data-part="tool-io-label">
        {label}
      </span>
      <div className="cb-tool-io-body">{children}</div>
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
  const waiting = isWaiting(row);
  const running = isLive(row) && !waiting;
  const clock = useClock(running && row.startedAt !== undefined, now);
  const end = waiting ? (
    <span className="cb-tool-end">
      <WaitingWord row={row} />
    </span>
  ) : running ? (
    row.startedAt !== undefined ? (
      // a ticking timer: hidden from screen readers so the live thread does not chatter (I2)
      <span className="cb-tool-end cb-faint" aria-hidden="true">
        {formatDuration(clock - row.startedAt, locale, { live: true })}
      </span>
    ) : null
  ) : expandable ? (
    <span className="cb-tool-end">
      <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
    </span>
  ) : null;
  const inner = (
    <>
      {running ? <Spinner size={16} /> : null}
      <ToolLabel row={row} />
      {end}
    </>
  );
  const toggle = () => {
    setAnimate(true);
    if (open === undefined) setOwn((o) => !o);
    onToggle?.();
  };
  const detail =
    expandable && isOpen ? (
      <ToolDetail
        row={row}
        id={id}
        animate={animate}
        {...(onViewAll ? { onViewAll } : {})}
        {...(onCopy ? { onCopy } : {})}
      />
    ) : null;
  if (row.link) {
    // a row with a link: the toggle (or the label) and the link side by side, never nested
    return (
      <div className="cb-tool-item" data-open={expandable && isOpen ? "true" : undefined}>
        <div
          className="cb-tool-row"
          data-part="tool-row"
          data-cap-part="tool-row"
          data-status={row.status}
          data-waiting={waiting ? row.waiting : undefined}
          data-linked="true"
        >
          {expandable ? (
            <button
              type="button"
              className="cb-tool-toggle"
              aria-expanded={isOpen}
              aria-controls={isOpen ? id : undefined}
              onClick={toggle}
            >
              {inner}
            </button>
          ) : (
            <span className="cb-tool-toggle">{inner}</span>
          )}
          <ToolLink link={row.link} />
        </div>
        {detail}
      </div>
    );
  }
  return (
    <div className="cb-tool-item" data-open={expandable && isOpen ? "true" : undefined}>
      {expandable ? (
        <button
          type="button"
          className="cb-tool-row"
          data-part="tool-row"
          data-cap-part="tool-row"
          data-status={row.status}
          data-waiting={waiting ? row.waiting : undefined}
          aria-expanded={isOpen}
          aria-controls={isOpen ? id : undefined}
          onClick={toggle}
        >
          {inner}
        </button>
      ) : (
        <div
          className="cb-tool-row"
          data-part="tool-row"
          data-cap-part="tool-row"
          data-status={row.status}
          data-waiting={waiting ? row.waiting : undefined}
        >
          {inner}
        </div>
      )}
      {detail}
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
