import { type JSX, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../controls/button";
import { formatDuration } from "../display/duration";
import type { Locale } from "../i18n";
import { messages } from "../i18n";
import { Icon } from "../icons/icon";
import { useDesignLink, useDesignLocale, useDesignT } from "../provider";
import { type AgentMapStatus, agentMapTokens, StatusDot } from "./agent-status";
import { useClock } from "./clock";
import { Spinner } from "./prose";
import { fillCopy } from "./tool-copy";

// Sub-agents in the stream (spec §6.16.15: the group and its Agent call blocks, agent map spec
// §9.5) and their pieces in the right panel and the properties panel. The data mirrors phase C
// (sub-agents spec §14): `SubagentView` from `GET /conversations/:id/subagents`, the parent-log
// events `subagent_dispatched` / `subagent_waiting` / `subagent_finished`, and the ephemeral
// `event: subagent_progress`. The components take plain rows; the mappers below turn the API
// shapes into rows.

/**
 * `SubagentView.status`: the latest child run's status; `limit` (from `subagent_finished` only):
 * it ended on its step or time limit or its tree's token budget, after handing back what it had.
 */
export type SubagentStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "limit"
  | "failed"
  | "aborted";

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
  /** The dispatch prompt (the `Agent` call's `prompt`), the call block's IN. */
  prompt?: string;
  /** The child's current tool summary ("Bash 运行核对脚本"), from `subagent_progress`. */
  current?: string;
  /** Tokens the child used, when known. */
  tokens?: number;
  /**
   * The child runs in the background (absent: it does). A fork skill's child, and a child of a
   * log written before background sub-agents, ran in the foreground: no "后台" in its line.
   */
  background?: boolean;
  /**
   * There is a child to open (absent: there is). False for a call refused before any dispatch,
   * whose id is still the call key: its block has no open action.
   */
  openable?: boolean;
  /** Why the call was refused before any dispatch (the tool result), shown in its line. */
  refusal?: string;
  status: SubagentStatus;
  toolCalls: number;
  /** Epoch ms of the latest run's start. */
  startedAt?: number;
  /** Epoch ms of the latest run's end. */
  finishedAt?: number;
  /** The run's duration when known exactly (`subagent_finished.durationMs`). */
  durationMs?: number;
  waiting?: SubagentWaitKind;
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

/**
 * A `subagent_finished.status` as the view's status: the token budget and the step / time limits
 * are `limit` (not a failure: the child handed back what it had); a wait timeout is a failure.
 */
export function subagentStatusOfFinish(s: SubagentFinishStatus): SubagentStatus {
  if (s === "completed" || s === "aborted") return s;
  if (s === "budget" || s === "max_steps" || s === "max_duration") return "limit";
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

/** What a waiting sub-agent waits for, as its row says it ("等待批准" / "Waiting for approval"). */
export function subagentWaitingLabel(kind: SubagentWaitKind, locale: Locale): string {
  return messages[locale][`subagent.waiting.${kind}`];
}

const active = (r: SubagentRowData) =>
  r.status === "queued" || r.status === "running" || r.status === "waiting";

/** A finished row's time: its exact duration when known, else from its start to its end. */
function endedMs(r: SubagentRowData): number | undefined {
  if (r.durationMs !== undefined) return r.durationMs;
  if (r.startedAt === undefined || r.finishedAt === undefined) return undefined;
  return r.finishedAt - r.startedAt;
}

// ── Agent call block ────────────────────────────────────────────────────────

/** What the call block's status line shows (the tree and `subagent_progress` feed it). */
export type AgentCallState = {
  status: AgentMapStatus;
  /** The child's current tool summary while it works ("Bash 运行核对脚本"). */
  current?: string;
  /** The child's time, shown once it has ended. */
  durationMs?: number;
  /** The child's tokens, shown once it has ended. */
  tokens?: number;
  /** The child runs in the background (default); false: the neutral "运行中" copy. */
  background?: boolean;
  /** Why the call was refused before any child ran: shown after "失败" instead of time. */
  refusal?: string;
};

export type AgentCallBlockProps = {
  /** The task description (the header after `Agent`). */
  description: string;
  /** The dispatch prompt, the body's IN (none: no body). */
  prompt: string;
  state: AgentCallState;
  /** Opens the child in the agent map (level 2); absent (no child): no action. */
  onOpen?: () => void;
  /** The prompt starts expanded (uncontrolled). */
  defaultExpanded?: boolean;
};

/**
 * One `Agent` call in the stream (§6.16.15, agent map spec §9.5, as Claude Code draws it): a tool
 * block whose header is `Agent` and the task description and whose body is IN with the prompt
 * (two lines with an ellipsis, expandable). Under it one status line: while the child works a
 * pulsing dot and "后台运行中：<current tool summary>", once it has ended its status dot and
 * "完成 · <time> · <tokens>" (failed and stopped say so); the action opens it in the agent map.
 */
export function AgentCallBlock({
  description,
  prompt,
  state,
  onOpen,
  defaultExpanded,
}: AgentCallBlockProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const [expanded, setExpanded] = useState(defaultExpanded === true);
  const [overflows, setOverflows] = useState(false);
  const promptRef = useRef<HTMLParagraphElement>(null);
  const promptId = useId();
  // The toggle shows only when the two clamped lines hide something (measured, and again on
  // resize); an expanded prompt keeps it so it can fold back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new prompt must be measured again
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [prompt, expanded]);

  const { status } = state;
  let text: ReactNode;
  if (status === "running" || status === "waiting") {
    const key = state.background === false ? (`${status}Fg` as const) : status;
    text =
      state.current !== undefined && state.current !== ""
        ? fillCopy(t(`agentMap.call.${key}`), { current: state.current })
        : t(`agentMap.call.${key}Idle`);
  } else {
    const word =
      status === "failed" ? (
        <span className="cb-fail-word" data-part="fail-word">
          {t("tool.failed")}
        </span>
      ) : status === "limit" ? (
        <span className="cb-warn-word" data-part="limit-word">
          {t("agentMap.status.limit")}
        </span>
      ) : status === "aborted" ? (
        t("subagent.stopped")
      ) : (
        t("agentMap.status.completed")
      );
    const rest =
      state.refusal !== undefined
        ? [state.refusal.split("\n")[0] ?? ""]
        : [
            ...(state.durationMs !== undefined ? [formatDuration(state.durationMs, locale)] : []),
            ...(state.tokens !== undefined ? [agentMapTokens(state.tokens, locale)] : []),
          ];
    text = (
      <>
        {word}
        {rest.length > 0 ? ` · ${rest.join(" · ")}` : null}
      </>
    );
  }

  return (
    <div className="cb-agent-call" data-part="agent-call-block" data-status={status}>
      <div className="cb-tool-box" data-part="tool-box">
        <div className="cb-agent-call-head" data-part="agent-call-head">
          <span className="cb-agent-call-label">
            <span className="cb-tool-name" data-part="agent-call-name">
              Agent
            </span>{" "}
            <span data-part="agent-call-desc">{description}</span>
          </span>
        </div>
        {prompt !== "" ? (
          <div className="cb-tool-detail" data-part="tool-detail">
            <div className="cb-tool-io" data-part="tool-io" data-io="in">
              <span className="cb-tool-io-label" data-part="tool-io-label">
                {t("tool.in")}
              </span>
              <div className="cb-tool-io-body">
                <p
                  ref={promptRef}
                  id={promptId}
                  className="cb-agent-call-prompt"
                  data-part="agent-call-prompt"
                  data-expanded={expanded ? "true" : "false"}
                >
                  {prompt}
                </p>
                {expanded || overflows ? (
                  <button
                    type="button"
                    className="cb-link-btn cb-agent-call-more"
                    data-part="agent-call-more"
                    aria-expanded={expanded}
                    aria-controls={promptId}
                    onClick={() => setExpanded((e) => !e)}
                  >
                    {t(expanded ? "agentMap.call.less" : "agentMap.call.more")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <div className="cb-agent-call-status" data-part="agent-call-status" data-status={status}>
        <StatusDot status={status} />
        <span
          className="cb-agent-call-text"
          data-part="agent-call-text"
          {...(state.refusal !== undefined ? { title: state.refusal } : {})}
        >
          {text}
        </span>
        {onOpen ? (
          <button
            type="button"
            className="cb-link-btn cb-agent-call-open"
            data-part="agent-call-open"
            onClick={onOpen}
          >
            {t("agentMap.call.open")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A sub-agent row as its call block's state: a queued child already works in the background. */
function callState(r: SubagentRowData): AgentCallState {
  const background = r.background === false ? { background: false } : {};
  if (active(r)) {
    return {
      status: r.status === "waiting" ? "waiting" : "running",
      ...(r.current !== undefined ? { current: r.current } : {}),
      ...background,
    };
  }
  const ms = endedMs(r);
  return {
    status: r.status as Exclude<SubagentStatus, "queued" | "running" | "waiting">,
    ...(ms !== undefined ? { durationMs: ms } : {}),
    ...(r.tokens !== undefined ? { tokens: r.tokens } : {}),
    ...(r.refusal !== undefined ? { refusal: r.refusal } : {}),
    ...background,
  };
}

// ── Group ───────────────────────────────────────────────────────────────────

export type SubagentGroupProps = {
  /** In child-creation order. */
  rows: SubagentRowData[];
  /** Opens a sub-agent (its call block's action). */
  onOpen(id: string): void;
  /** Controlled open state of a finished group; a running group is always open. */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?(): void;
  /** Sub-agents whose prompt starts expanded (uncontrolled). */
  defaultExpanded?: string[];
  /** Opens the agent map (agent map spec §9.2): a link button at the end of the header. */
  onOpenMap?: () => void;
};

/**
 * The sub-agents of a turn (§6.16.15): a summary line like tool groups' over one Agent call block
 * per sub-agent.
 */
export function SubagentGroup({
  rows,
  onOpen,
  open,
  defaultOpen,
  onToggle,
  defaultExpanded,
  onOpenMap,
}: SubagentGroupProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const [own, setOwn] = useState(defaultOpen === true);
  const [animate, setAnimate] = useState(false);
  const id = useId();
  const running = rows.filter(active);
  // every active row waits for a person: the header says so instead of the spinner and the verb
  const waitingFor = running.every((r) => r.status === "waiting") ? running[0]?.waiting : null;
  // the header's link (§6.16.9: beside the toggle, never inside it)
  const mapLink = onOpenMap ? (
    <button
      type="button"
      className="cb-link-btn cb-tool-link"
      data-part="subagent-map-link"
      onClick={onOpenMap}
    >
      {t("agentMap.title")}
    </button>
  ) : null;
  const calls = (
    <div className="cb-agent-calls" data-part="agent-calls">
      {rows.map((r) => (
        <AgentCallBlock
          key={r.id}
          description={r.description}
          prompt={r.prompt ?? ""}
          state={callState(r)}
          defaultExpanded={defaultExpanded?.includes(r.id) === true}
          {...(r.openable === false ? {} : { onOpen: () => onOpen(r.id) })}
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
          {mapLink}
        </div>
        {calls}
      </div>
    );
  }
  const failed = rows.filter((r) => r.status === "failed").length;
  const limited = rows.filter((r) => r.status === "limit").length;
  const totalCalls = rows.reduce((n, r) => n + r.toolCalls, 0);
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
  const toggle = () => {
    setAnimate(true);
    if (open === undefined) setOwn((o) => !o);
    onToggle?.();
  };
  const label = (
    <span className="cb-tool-label">
      {fillCopy(t("subagent.done"), { n: rows.length })}
      {failed > 0 ? (
        <span className="cb-fail-word" data-part="fail-word">
          {fillCopy(t("tool.failedCount"), { n: failed })}
        </span>
      ) : null}
      {limited > 0 ? (
        <span className="cb-warn-word" data-part="limit-word">
          {fillCopy(t("subagent.limitCount"), { n: limited })}
        </span>
      ) : null}
      <span className="cb-faint">
        {` · ${[
          fillCopy(t("subagent.totalCalls"), { n: totalCalls }),
          ...(span === undefined ? [] : [formatDuration(span, locale)]),
        ].join(" · ")}`}
      </span>
    </span>
  );
  const chevron = <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />;
  return (
    <div className="cb-tool-group" data-part="subagent-group">
      {mapLink ? (
        <div className="cb-tool-line" data-part="tool-line" data-linked="true">
          <button
            type="button"
            className="cb-tool-toggle"
            aria-expanded={isOpen}
            aria-controls={isOpen ? id : undefined}
            onClick={toggle}
          >
            {label}
            {chevron}
          </button>
          {mapLink}
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
          {label}
          {chevron}
        </button>
      )}
      {isOpen ? (
        <div id={id} className="cb-expand" data-animate={animate ? "true" : undefined}>
          {calls}
        </div>
      ) : null}
    </div>
  );
}

// ── Right panel and properties pieces ───────────────────────────────────────

/**
 * The task a sub-agent was given (gray block) and the "agent · 子智能体 · model · tools" line.
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
      {item.kind === "subagent" && item.status === "limit" ? (
        <span className="cb-warn-word" data-part="limit-word">
          {t("agentMap.status.limit")}
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
        <span className="cb-muted">
          {formatDuration(end - item.startedAt, locale, { live: running })}
        </span>
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
