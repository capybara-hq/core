import { type JSX, type ReactNode, useId, useState } from "react";
import { IconButton } from "../controls/button";
import type { Locale } from "../i18n";
import { messages } from "../i18n";
import { Icon } from "../icons/icon";
import { useDesignLink, useDesignLocale, useDesignT } from "../provider";
import { useClock } from "./clock";
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
  if (v.status === "waiting") row.waiting = subagentWaitKind(v);
  return row;
}

/** What a waiting `SubagentView` waits for: an approval, else an answer, else a connection. */
export function subagentWaitKind(
  v: Pick<SubagentViewLike, "pendingApprovalIds" | "pendingQuestionIds">,
): SubagentWaitKind {
  return v.pendingApprovalIds.length > 0
    ? "approval"
    : v.pendingQuestionIds.length > 0
      ? "input"
      : "connect";
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

/** Active but waiting for a person (§6.16.15): no spinner and no clock, the waiting word. */
const ticking = (r: SubagentRowData) => active(r) && r.status !== "waiting";

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
 * A row waiting for a person has no spinner and no duration, only the waiting word.
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
  const clock = useClock(ticking(row), now);
  const ms = row.status === "waiting" ? undefined : rowMs(row, clock);
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
      {ticking(row) ? <Spinner size={16} /> : null}
      <span className="cb-agent-tag" data-part="agent-tag">
        {row.agentType}
      </span>
      <span className="cb-tool-label cb-subagent-desc">{row.description}</span>
      <span className="cb-tool-end cb-subagent-end cb-faint">
        {status}
        {/* Its own flex item, as the reference draws it: the end's gap falls on both sides. */}
        {status ? <span> · </span> : null}
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
  const running = rows.filter(active);
  // the group ticks for its rows (they get `now`), only while one is active and not waiting
  const clock = useClock(running.some(ticking), now);
  // every active row waits for a person: the header says so instead of the spinner and the verb
  const waitingFor = running.every((r) => r.status === "waiting") ? running[0]?.waiting : null;
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
          {waitingFor === null ? <Spinner size={16} /> : null}
          <span className="cb-tool-label">
            {waitingFor === null ? (
              fillCopy(t("subagent.running"), { n: running.length })
            ) : (
              <span className="cb-accent-word" data-part="waiting-word">
                {t(`subagent.waiting.${waitingFor ?? "approval"}`)}
              </span>
            )}
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

/**
 * The task a sub-agent was given (gray block) and the "agent · 子 agent · model · tools" line.
 * `agentHref`: an org agent's page; its name becomes a link (a template's name stays plain).
 */
export function SubagentTask({
  text,
  agent,
  agentHref,
  model,
  tools,
}: {
  text: string;
  agent: string;
  agentHref?: string;
  model: string;
  tools: string;
}): JSX.Element {
  const t = useDesignT();
  const Link = useDesignLink();
  const rest = [t("subagent.kind"), model, tools].filter((s) => s !== "").join(" · ");
  return (
    <>
      <div className="cb-subagent-task" data-part="subagent-task">
        <div className="cb-subagent-task-label">{t("subagent.taskLabel")}</div>
        {text}
      </div>
      <div className="cb-tool-line" data-part="subagent-meta">
        <span className="cb-tool-label">
          {agentHref && agent !== "" ? (
            <>
              <Link href={agentHref} className="cb-link-btn">
                {agent}
              </Link>
              {` · ${rest}`}
            </>
          ) : (
            [agent, rest].filter((s) => s !== "").join(" · ")
          )}
        </span>
      </div>
    </>
  );
}

/** A background Bash task's status (the web maps the kernel's task views onto it). */
export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "lost";

export type BackgroundTaskItem = {
  kind: "task";
  id: string;
  /** The command's description, the row's name. */
  description: string;
  status: BackgroundTaskStatus;
  /** Epoch ms. */
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** A stop is under way (the kernel view's `stopping`): the row stays running, with no stop. */
  stopping?: boolean;
  /** Drawn indented, under the sub-agent that started it. */
  nested?: boolean;
};

export type BackgroundSubagentItem = {
  kind: "subagent";
  id: string;
  name: string;
  status: SubagentStatus;
  /** What a `waiting` sub-agent waits for: its row shows that word instead of the clock. */
  waiting?: SubagentWaitKind;
  startedAt: number;
  finishedAt?: number;
  /** Its own background tasks, drawn nested under it while they run. */
  tasks?: BackgroundItem[];
};

export type BackgroundItem = BackgroundTaskItem | BackgroundSubagentItem;

const itemActive = (i: BackgroundItem): boolean =>
  i.kind === "task"
    ? i.status === "running"
    : i.status === "queued" || i.status === "running" || i.status === "waiting";

const itemName = (i: BackgroundItem): string => (i.kind === "task" ? i.description : i.name);

/** The word a finished task ends with: success is never colored, failure is `fail`. */
function taskStatusWord(
  status: Exclude<BackgroundTaskStatus, "running">,
  t: ReturnType<typeof useDesignT>,
): JSX.Element {
  switch (status) {
    case "completed":
      return (
        <span className="cb-muted" data-part="task-status">
          {t("background.done")}
        </span>
      );
    case "stopped":
      return (
        <span className="cb-muted" data-part="task-status">
          {t("background.stopped")}
        </span>
      );
    case "lost":
      return (
        <span className="cb-muted" data-part="task-status">
          {t("background.lost")}
        </span>
      );
    case "failed":
      return (
        <span className="cb-fail-word" data-part="fail-word">
          {t("background.failed")}
        </span>
      );
    case "timed_out":
      return (
        <span className="cb-fail-word" data-part="fail-word">
          {t("background.timedOut")}
        </span>
      );
  }
}

export type BackgroundTaskRowProps = {
  item: BackgroundItem;
  /** The clock for running rows. */
  now: number;
  /** Indented under its sub-agent. */
  nested?: boolean;
  onStop(id: string): void;
  onOpen(id: string): void;
};

/**
 * One row of the "Background tasks" section (§6.16.17): a running one has the `spinner`, the name,
 * the elapsed time and a dense stop button; a stopping one says "正在停止…" instead of the button;
 * a sub-agent waiting for a person has no spinner and says what it waits for instead of the time;
 * a finished one has its status word and no spinner.
 */
export function BackgroundTaskRow({
  item,
  now,
  nested,
  onStop,
  onOpen,
}: BackgroundTaskRowProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const name = itemName(item);
  const running = itemActive(item);
  const waiting = item.kind === "subagent" && item.status === "waiting";
  const end = running ? now : (item.finishedAt ?? now);
  const stopping = item.kind === "task" && item.stopping === true;
  const isNested = nested === true || (item.kind === "task" && item.nested === true);
  return (
    <div
      className="cb-property-row cb-task-row"
      data-part="task-row"
      data-nested={isNested ? "true" : undefined}
    >
      {running && !waiting ? <Spinner /> : null}
      <button
        type="button"
        className="cb-property-link cb-property-name"
        onClick={() => onOpen(item.id)}
      >
        {name}
      </button>
      {item.kind === "task" && item.status !== "running" ? taskStatusWord(item.status, t) : null}
      {item.kind === "subagent" && item.status === "failed" ? (
        <span className="cb-fail-word" data-part="fail-word">
          {t("background.failed")}
        </span>
      ) : null}
      {item.kind === "subagent" && item.status === "aborted" ? (
        <span className="cb-muted" data-part="task-status">
          {t("background.stopped")}
        </span>
      ) : null}
      {waiting ? (
        <span className="cb-accent-word" data-part="waiting-word">
          {t(`subagent.waiting.${item.waiting ?? "approval"}`)}
        </span>
      ) : (
        <span className="cb-muted">{subagentDuration(end - item.startedAt, locale)}</span>
      )}
      {stopping ? (
        <span className="cb-muted" role="status" aria-live="polite">
          {t("background.stopping")}
        </span>
      ) : null}
      {running && !stopping ? (
        <IconButton
          density="dense"
          label={fillCopy(t("background.stop"), { name })}
          icon={<Icon name="square" size={12} />}
          onClick={() => onStop(item.id)}
        />
      ) : null}
    </div>
  );
}

export type BackgroundTasksProps = {
  items: BackgroundItem[];
  /** The clock for running rows (default: the time now, ticking while a row runs). */
  now?: number;
  onStop(id: string): void;
  /** Opens a row's record on the right (also the newest finished one, from "N completed"). */
  onOpen(id: string): void;
  /** The "N completed ›" wording, given the count (default: the design copy). */
  completedLabel?: (n: number) => string;
};

function flatten(items: BackgroundItem[]): BackgroundItem[] {
  return items.flatMap((i) => [i, ...(i.kind === "subagent" ? flatten(i.tasks ?? []) : [])]);
}

/**
 * The "Background tasks" section body (§6.16.17): the running sub-agents and tasks (a sub-agent's
 * own tasks nested under it), then "N completed ›", counting finished tasks and sub-agents
 * together, which opens the newest.
 */
export function BackgroundTasks({
  items,
  now,
  onStop,
  onOpen,
  completedLabel,
}: BackgroundTasksProps): JSX.Element {
  const t = useDesignT();
  const all = flatten(items);
  const clock = useClock(
    all.some((i) => itemActive(i) && !(i.kind === "subagent" && i.status === "waiting")),
    now,
  );
  const finished = all.filter((i) => !itemActive(i));
  const newest = finished.reduce<BackgroundItem | undefined>(
    (best, i) =>
      best === undefined || (i.finishedAt ?? i.startedAt) > (best.finishedAt ?? best.startedAt)
        ? i
        : best,
    undefined,
  );
  // The rows are the section's own children, `space.1` apart (the reference's section gap).
  const rows = (list: BackgroundItem[], hasParent: boolean): ReactNode[] =>
    list.flatMap((i) => {
      const run = itemActive(i);
      return [
        ...(run
          ? [
              <BackgroundTaskRow
                key={i.id}
                item={i}
                now={clock}
                nested={hasParent}
                onStop={onStop}
                onOpen={onOpen}
              />,
            ]
          : []),
        ...(i.kind === "subagent" ? rows(i.tasks ?? [], true) : []),
      ];
    });
  return (
    <>
      {rows(items, false)}
      {finished.length > 0 || !all.some(itemActive) ? (
        <button
          type="button"
          className="cb-property-row cb-property-more"
          onClick={() => {
            if (newest) onOpen(newest.id);
          }}
        >
          {completedLabel
            ? completedLabel(finished.length)
            : fillCopy(t("subagent.completed"), { n: finished.length })}
          <Icon name="chevron-right" size={12} />
        </button>
      ) : null}
    </>
  );
}
