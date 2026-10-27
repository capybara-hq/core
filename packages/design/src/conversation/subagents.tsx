import { type JSX, type ReactNode, useId, useState } from "react";
import { IconButton } from "../controls/button";
import type { Locale } from "../i18n";
import { messages } from "../i18n";
import { Icon } from "../icons/icon";
import { useDesignLocale, useDesignT } from "../provider";
import { Spinner } from "./prose";
import { fillCopy } from "./tool-copy";

// Sub-agents in the stream (spec §6.16.15) and their pieces in the right panel and the properties
// panel. The data mirrors phase C (sub-agents spec §14): `SubagentView` from
// `GET /conversations/:id/subagents`, the parent-log events `subagent_dispatched` /
// `subagent_waiting` / `subagent_finished`, and the ephemeral `event: subagent_progress`. The
// components take plain rows; the mappers below turn the API shapes into rows.

/** `SubagentView.status`: the latest child run's status. */
export type SubagentStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "aborted";

/** `subagent_finished.status`. */
export type SubagentFinishStatus =
  | "completed"
  | "max_steps"
  | "max_duration"
  | "budget"
  | "aborted"
  | "timed_out"
  | "failed";

/** What a waiting sub-agent waits for (`subagent_waiting.kind`). */
export type SubagentWaitKind = "approval" | "input" | "connect";

export type SubagentRowData = {
  /** The child conversation id (`subagentId`). */
  id: string;
  /** The kind tag (`agentType`). */
  agentType: string;
  /** The task name (the dispatch's `description`). */
  description: string;
  status: SubagentStatus;
  toolCalls: number;
  /** Epoch ms of the latest run's start. */
  startedAt?: number;
  /** Epoch ms of the latest run's end. */
  finishedAt?: number;
  /** The run's duration when known exactly (`subagent_finished.durationMs`). */
  durationMs?: number;
  waiting?: SubagentWaitKind;
  /** The in-place expansion: a step summary and the result. */
  summary?: { steps: string[]; result: string };
};

// ── Mappers from the phase C API ────────────────────────────────────────────

/** The fields of phase C's `SubagentView` the rows use. */
export type SubagentViewLike = {
  id: string;
  agentType: string;
  description: string;
  status: SubagentStatus;
  toolCalls: number;
  startedAt: string;
  finishedAt: string | null;
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
};

/** `subagent_progress` data, by `subagentId`. */
export type SubagentProgress = Record<
  string,
  { step: number; toolCalls: number; lastToolKey?: string }
>;

/** A `subagent_finished.status` as the view's status: budget and step / time caps are failures. */
export function subagentStatusOfFinish(s: SubagentFinishStatus): SubagentStatus {
  if (s === "completed" || s === "aborted") return s;
  return "failed";
}

/** One `SubagentView` as a row. */
export function subagentRowFromView(v: SubagentViewLike): SubagentRowData {
  const row: SubagentRowData = {
    id: v.id,
    agentType: v.agentType,
    description: v.description,
    status: v.status,
    toolCalls: v.toolCalls,
    startedAt: Date.parse(v.startedAt),
  };
  if (v.finishedAt !== null) row.finishedAt = Date.parse(v.finishedAt);
  if (v.status === "waiting") {
    row.waiting =
      v.pendingApprovalIds.length > 0
        ? "approval"
        : v.pendingQuestionIds.length > 0
          ? "input"
          : "connect";
  }
  return row;
}

/**
 * The rows of a conversation's sub-agents in child-creation order. The API lists the newest
 * first (pages concatenated in order), so the list is reversed; live progress raises the call
 * count of an unfinished row (it never lowers it, since the summary may be newer).
 */
export function subagentRowsFromViews(
  views: readonly SubagentViewLike[],
  progress: SubagentProgress = {},
): SubagentRowData[] {
  return [...views].reverse().map((v) => {
    const row = subagentRowFromView(v);
    const p = progress[v.id];
    if (p && v.finishedAt === null && p.toolCalls > row.toolCalls) row.toolCalls = p.toolCalls;
    return row;
  });
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** A sub-agent duration as the reference writes it: "41 秒", "1分12秒" / "41s", "1m 12s". */
export function subagentDuration(ms: number, locale: Locale): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const t = messages[locale];
  if (m === 0) return fillCopy(t["subagent.durationS"], { s });
  return fillCopy(t["subagent.durationMS"], { m, s: String(s).padStart(2, "0") });
}

const active = (r: SubagentRowData) =>
  r.status === "queued" || r.status === "running" || r.status === "waiting";

function rowMs(r: SubagentRowData, now: number): number | undefined {
  if (r.durationMs !== undefined && !active(r)) return r.durationMs;
  if (r.startedAt === undefined) return undefined;
  const end = active(r) ? now : (r.finishedAt ?? now);
  return end - r.startedAt;
}

// ── Row ─────────────────────────────────────────────────────────────────────

export type SubagentRowProps = {
  row: SubagentRowData;
  /** The row is the one open in the right panel. */
  open?: boolean;
  /** Controlled in-place expansion (rows with a `summary`). */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onOpen(): void;
  onToggle?(): void;
  /** The clock for running rows (the caller re-renders each second). */
  now?: number;
};

/**
 * One sub-agent (§6.16.15): spinner, kind tag, task, status, "N 次调用 · <duration>", chevron.
 * A row with a summary expands in place; any other row opens the sub-agent on the right.
 */
export function SubagentRow({
  row,
  open,
  expanded,
  defaultExpanded,
  onOpen,
  onToggle,
  now,
}: SubagentRowProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const [own, setOwn] = useState(defaultExpanded === true);
  const [animate, setAnimate] = useState(false);
  const id = useId();
  const expandable = row.summary !== undefined;
  const isExpanded = expandable && (expanded ?? own);
  const ms = rowMs(row, now ?? Date.now());
  const status: ReactNode =
    row.status === "failed" ? (
      <span className="cb-fail-word" data-part="fail-word">
        {t("tool.failed")}
      </span>
    ) : row.status === "aborted" ? (
      <span className="cb-muted">{t("subagent.stopped")}</span>
    ) : row.status === "waiting" ? (
      <span className="cb-accent-word" data-part="waiting-word">
        {t(`subagent.waiting.${row.waiting ?? "approval"}`)}
      </span>
    ) : null;
  const meta = [
    fillCopy(t("subagent.calls"), { n: row.toolCalls }),
    ...(ms === undefined ? [] : [subagentDuration(ms, locale)]),
  ].join(" · ");
  const inner = (
    <>
      {active(row) ? <Spinner /> : null}
      <span className="cb-agent-tag" data-part="agent-tag">
        {row.agentType}
      </span>
      <span className="cb-tool-label cb-subagent-desc">{row.description}</span>
      <span className="cb-tool-end cb-subagent-end cb-faint">
        {status}
        {status ? " · " : null}
        {meta}
      </span>
      <Icon name={isExpanded ? "chevron-down" : "chevron-right"} size={12} />
    </>
  );
  const common = {
    type: "button" as const,
    className: "cb-tool-row cb-subagent-row",
    "data-part": "subagent-row",
    "data-status": row.status,
    "data-open": open ? "true" : undefined,
    "aria-current": open ? ("true" as const) : undefined,
  };
  return (
    <div className="cb-tool-item" data-expanded={isExpanded ? "true" : undefined}>
      {expandable ? (
        <button
          {...common}
          aria-expanded={isExpanded}
          aria-controls={isExpanded ? id : undefined}
          onClick={() => {
            setAnimate(true);
            if (expanded === undefined) setOwn((o) => !o);
            onToggle?.();
          }}
        >
          {inner}
        </button>
      ) : (
        <button
          {...common}
          aria-label={fillCopy(t("subagent.openOnRight"), { name: row.description })}
          onClick={onOpen}
        >
          {inner}
        </button>
      )}
      {isExpanded && row.summary ? (
        <div
          id={id}
          className="cb-subagent-steps cb-expand"
          data-part="subagent-steps"
          data-animate={animate ? "true" : undefined}
        >
          {row.summary.steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional
            <div key={i}>{s}</div>
          ))}
          <p className="cb-subagent-result" data-part="subagent-result">
            {row.summary.result}
          </p>
          <button type="button" className="cb-link-btn" onClick={onOpen}>
            <Icon name="maximize-2" size={12} />
            {t("subagent.openRecord")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── Group ───────────────────────────────────────────────────────────────────

export type SubagentGroupProps = {
  /** In child-creation order. */
  rows: SubagentRowData[];
  /** The id of the row open in the right panel. */
  openId?: string;
  onOpen(id: string): void;
  /** Controlled open state of a finished group; a running group is always open. */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?(): void;
  /** Rows expanded in place at first (uncontrolled). */
  defaultExpanded?: string[];
  now?: number;
};

/** The sub-agents of a turn (§6.16.15): a summary line over a tool box, like tool groups. */
export function SubagentGroup({
  rows,
  openId,
  onOpen,
  open,
  defaultOpen,
  onToggle,
  defaultExpanded,
  now,
}: SubagentGroupProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const [own, setOwn] = useState(defaultOpen === true);
  const [animate, setAnimate] = useState(false);
  const id = useId();
  const clock = now ?? Date.now();
  const running = rows.filter(active);
  const box = (
    <div className="cb-tool-box" data-part="tool-box">
      {rows.map((r) => (
        <SubagentRow
          key={r.id}
          row={r}
          open={r.id === openId}
          defaultExpanded={defaultExpanded?.includes(r.id) === true}
          onOpen={() => onOpen(r.id)}
          now={clock}
        />
      ))}
    </div>
  );
  if (running.length > 0) {
    const finished = rows.length - running.length;
    return (
      <div className="cb-tool-group" data-part="subagent-group">
        <div className="cb-tool-line" data-part="tool-line">
          <Spinner />
          <span className="cb-tool-label">
            {fillCopy(t("subagent.running"), { n: running.length })}
            {finished > 0 ? (
              <span className="cb-faint">
                {` · ${fillCopy(t("subagent.finishedCount"), { n: finished })}`}
              </span>
            ) : null}
          </span>
        </div>
        {box}
      </div>
    );
  }
  const failed = rows.filter((r) => r.status === "failed").length;
  const calls = rows.reduce((n, r) => n + r.toolCalls, 0);
  const starts = rows.flatMap((r) => (r.startedAt === undefined ? [] : [r.startedAt]));
  const ends = rows.flatMap((r) =>
    r.finishedAt !== undefined
      ? [r.finishedAt]
      : r.startedAt !== undefined && r.durationMs !== undefined
        ? [r.startedAt + r.durationMs]
        : [],
  );
  const span =
    starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : undefined;
  const isOpen = open ?? own;
  return (
    <div className="cb-tool-group" data-part="subagent-group">
      <button
        type="button"
        className="cb-tool-line"
        data-part="tool-line"
        aria-expanded={isOpen}
        aria-controls={isOpen ? id : undefined}
        onClick={() => {
          setAnimate(true);
          if (open === undefined) setOwn((o) => !o);
          onToggle?.();
        }}
      >
        <span className="cb-tool-label">
          {fillCopy(t("subagent.done"), { n: rows.length })}
          {failed > 0 ? (
            <span className="cb-fail-word" data-part="fail-word">
              {fillCopy(t("tool.failedCount"), { n: failed })}
            </span>
          ) : null}
          <span className="cb-faint">
            {` · ${[
              fillCopy(t("subagent.totalCalls"), { n: calls }),
              ...(span === undefined ? [] : [subagentDuration(span, locale)]),
            ].join(" · ")}`}
          </span>
        </span>
        <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {isOpen ? (
        <div id={id} className="cb-expand" data-animate={animate ? "true" : undefined}>
          {box}
        </div>
      ) : null}
    </div>
  );
}

// ── Right panel and properties pieces ───────────────────────────────────────

/** The task a sub-agent was given (gray block) and the "agent · 子 agent · model · tools" line. */
export function SubagentTask({
  text,
  agent,
  model,
  tools,
}: {
  text: string;
  agent: string;
  model: string;
  tools: string;
}): JSX.Element {
  const t = useDesignT();
  return (
    <>
      <div className="cb-subagent-task" data-part="subagent-task">
        <div className="cb-subagent-task-label">{t("subagent.taskLabel")}</div>
        {text}
      </div>
      <div className="cb-tool-line" data-part="subagent-meta">
        <span className="cb-tool-label">
          {[agent, t("subagent.kind"), model, tools].filter((s) => s !== "").join(" · ")}
        </span>
      </div>
    </>
  );
}

export type BackgroundTasksProps = {
  running: { id: string; name: string; elapsed: string }[];
  completed: number;
  onStop(id: string): void;
  onOpen(id: string): void;
  onCompleted(): void;
};

/** The "Background tasks" section body (§6.16.17): running sub-agents, then "N completed ›". */
export function BackgroundTasks({
  running,
  completed,
  onStop,
  onOpen,
  onCompleted,
}: BackgroundTasksProps): JSX.Element {
  const t = useDesignT();
  // The rows are the section's own children, `space.1` apart (the reference's section gap).
  return (
    <>
      {running.map((r) => (
        <div key={r.id} className="cb-property-row" data-part="property-row">
          <Spinner />
          <button
            type="button"
            className="cb-property-link cb-property-name"
            onClick={() => onOpen(r.id)}
          >
            {r.name}
          </button>
          <span className="cb-muted">{r.elapsed}</span>
          <IconButton
            density="dense"
            label={fillCopy(t("subagent.stop"), { name: r.name })}
            icon={<Icon name="square" size={12} />}
            onClick={() => onStop(r.id)}
          />
        </div>
      ))}
      {completed > 0 || running.length === 0 ? (
        <button type="button" className="cb-property-row cb-property-more" onClick={onCompleted}>
          {fillCopy(t("subagent.completed"), { n: completed })}
          <Icon name="chevron-right" size={12} />
        </button>
      ) : null}
    </>
  );
}
