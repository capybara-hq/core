import * as RD from "@radix-ui/react-dialog";
import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { BoxScope } from "../layout/box";
import { useFocusReturn } from "../overlays/focus-return";
import { useDesignLocale, useDesignT } from "../provider";
import { type AgentMapStatus, agentMapTokens, StatusDot } from "./agent-status";
import { useClock } from "./clock";
import { type BackgroundTaskItem, type BackgroundTaskStatus, subagentDuration } from "./subagents";
import { fillCopy } from "./tool-copy";

// The agent map (spec §6.16.28, agent map spec §9): a dialog over the conversation page whose
// level 1 is the tree of agents, columns by depth with elbow connectors, every node one fixed
// height, status only as a dot (with a legend), and the root's background tasks under its column;
// level 2 is one agent's summary (AgentDetail), level 3 its transcript (TranscriptFrame).

export type AgentMapNode = {
  id: string;
  /** The task description (the root: the conversation title). */
  description: string;
  model: string;
  durationMs: number;
  tokens: number;
  status: AgentMapStatus;
  children: AgentMapNode[];
};

/** The root's own background tasks (the same rows as the properties panel's). */
export type AgentMapBackground = BackgroundTaskItem;

/**
 * The dialog width of each level: the tree 1100; one agent's summary and its transcript the
 * conversation's column (`layout.chat`) plus the dialog's own padding (`chat`, agent-map.css).
 */
const LEVEL_SIZE = { tree: "1100", detail: "chat", transcript: "chat" } as const;

const STATUSES: AgentMapStatus[] = ["running", "waiting", "completed", "failed", "aborted"];

/** A background task's status as a dot. */
function taskDot(s: BackgroundTaskStatus): AgentMapStatus {
  switch (s) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
    case "stopped":
    case "lost":
      return "aborted";
  }
}

export type AgentMapDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /**
   * The level shown: the width follows it (the tree 1100; levels 2 and 3 the conversation's column
   * plus the dialog's padding). The tree's head (title, close) is
   * the frame's; levels 2 and 3 draw their own ({@link AgentDetail}, {@link TranscriptFrame}).
   */
  level: "tree" | "detail" | "transcript";
  /** Drawn in place, without the portal and the scrim (the reference blocks of `/dev/ui`). */
  inline?: boolean;
  /**
   * Back one level (levels 2 and 3): Esc calls it instead of closing the dialog. Absent (the
   * tree): Esc closes.
   */
  onBack?: () => void;
  /**
   * What the dialog shows (e.g. `detail:<id>`): when it changes while the dialog stays open, focus
   * moves to the new content's back button, else the head's title (the old focus is gone).
   */
  view?: string;
  children: ReactNode;
};

/** Inside the portal dialog the head's title is the Radix title (the dialog's name). */
const RadixFrame = createContext(false);

/**
 * The head of every level (§6.16.28): an optional back button and status dot, the title and
 * close, then the meta lines (levels 2 and 3), indented past the back button.
 */
function AgentMapHead({
  title,
  status,
  onBack,
  onClose,
  meta,
}: {
  title: string;
  status?: AgentMapStatus;
  onBack?: () => void;
  onClose(): void;
  meta?: ReactNode;
}): JSX.Element {
  const t = useDesignT();
  const radix = useContext(RadixFrame);
  const Title = radix ? RD.Title : "h2";
  return (
    <div
      className="cb-amap-head"
      data-part="agent-map-head"
      data-back={onBack ? "true" : undefined}
    >
      <div className="cb-amap-head-line">
        {onBack ? (
          <IconButton
            label={t("agentMap.back")}
            icon={<Icon name="arrow-left" size={14} />}
            density="dense"
            onClick={onBack}
          />
        ) : null}
        {status ? <StatusDot status={status} /> : null}
        {/* focusable from script only: a level change puts focus here when there is no back */}
        <Title className="cb-amap-title" data-part="agent-map-title" tabIndex={-1}>
          {title}
        </Title>
        <IconButton
          label={t("overlay.close")}
          icon={<Icon name="x" size={14} />}
          density="dense"
          onClick={onClose}
        />
      </div>
      {meta}
    </div>
  );
}

/**
 * The agent map's dialog frame (§6.16.28): the ordinary dialog ground, border, radius and shadow
 * (§6.7) at the level's width, the tree's head (title, close) at level 1, and the level's content.
 * Esc closes the tree and goes back one level from levels 2 and 3 (`onBack`); focus is trapped and
 * returned, and moves to the head when the view changes.
 */
export function AgentMapDialog({
  open,
  onOpenChange,
  level,
  inline,
  onBack,
  view,
  children,
}: AgentMapDialogProps): JSX.Element | null {
  const t = useDesignT();
  const focusReturn = useFocusReturn();
  const content = useRef<HTMLDivElement>(null);
  const shown = useRef(view ?? level);
  const current = view ?? level;
  useEffect(() => {
    if (shown.current === current) return;
    shown.current = current;
    const head = content.current?.querySelector('[data-part="agent-map-head"]');
    const back = head?.querySelector<HTMLElement>(`button[aria-label="${t("agentMap.back")}"]`);
    const title = head?.querySelector<HTMLElement>('[data-part="agent-map-title"]');
    (back ?? title)?.focus();
  }, [current, t]);
  // Levels 1 and 2 are a dialog box (spec §1); level 3's thread is a pane ({@link TranscriptFrame}).
  // The tree level pads what it shows (the tree, or a page's loading bars or error line).
  const body = (
    <BoxScope kind="dialog">
      {level === "tree" ? (
        <>
          <AgentMapHead title={t("agentMap.title")} onClose={() => onOpenChange(false)} />
          <div className="cb-amap-content" data-part="agent-map-content">
            {children}
          </div>
        </>
      ) : (
        children
      )}
    </BoxScope>
  );
  if (inline) {
    if (!open) return null;
    return (
      <div
        ref={content}
        className="cb-dialog cb-amap-dialog"
        data-part="agent-map-dialog"
        data-size={LEVEL_SIZE[level]}
        data-level={level}
        data-inline="true"
        role="dialog"
        aria-label={t("agentMap.title")}
      >
        {body}
      </div>
    );
  }
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-scrim" />
        <RD.Content
          ref={content}
          className="cb-dialog cb-amap-dialog"
          data-part="agent-map-dialog"
          data-size={LEVEL_SIZE[level]}
          data-level={level}
          aria-describedby={undefined}
          onOpenAutoFocus={() => focusReturn.capture()}
          onCloseAutoFocus={focusReturn.restore}
          onEscapeKeyDown={(e) => {
            if (!onBack) return;
            e.preventDefault();
            onBack();
          }}
        >
          <RadixFrame.Provider value={true}>{body}</RadixFrame.Provider>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Background task rows (level 1 under the root column, level 2 in its section). */
function TaskRows({ tasks, now }: { tasks: AgentMapBackground[]; now: number }): JSX.Element {
  const locale = useDesignLocale();
  return (
    <ul className="cb-amap-background-list">
      {tasks.map((b) => (
        <li key={b.id} className="cb-amap-task" data-part="agent-task">
          <StatusDot status={taskDot(b.status)} />
          <span className="cb-amap-task-tag" data-part="agent-task-tag">
            Bash
          </span>
          <span className="cb-amap-task-name">{b.description}</span>
          <span className="cb-amap-task-time" data-part="agent-task-time">
            {subagentDuration(
              (b.status === "running" ? now : (b.finishedAt ?? now)) - b.startedAt,
              locale,
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export type AgentMapTreeProps = {
  root: AgentMapNode;
  /** The root's own background tasks, drawn under the root column. */
  background: AgentMapBackground[];
  /** The node open at level 2 (drawn with the `accent` border). */
  selectedId?: string;
  onOpen(id: string): void;
  /** The clock for running background tasks (default: the time now, ticking while one runs). */
  now?: number;
};

const countNodes = (n: AgentMapNode): number =>
  1 + n.children.reduce((s, c) => s + countNodes(c), 0);
const countRunning = (n: AgentMapNode): number =>
  (n.status === "running" ? 1 : 0) + n.children.reduce((s, c) => s + countRunning(c), 0);
const depthOf = (n: AgentMapNode): number => 1 + Math.max(0, ...n.children.map(depthOf));

/**
 * Level 1 of the agent map (§6.16.28): the count line, the tree (columns by depth, the parent
 * centred on its children, elbow connectors), the root's background tasks under the root column
 * and the status legend.
 */
export function AgentMapTree({
  root,
  background,
  selectedId,
  onOpen,
  now,
}: AgentMapTreeProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const clock = useClock(
    background.some((b) => b.status === "running"),
    now,
  );
  const count = [
    fillCopy(t("agentMap.count"), { n: countNodes(root) }),
    fillCopy(t("agentMap.running"), { n: countRunning(root) }),
    t("agentMap.hint"),
  ].join(" · ");

  const node = (n: AgentMapNode, depth: number): JSX.Element => {
    const meta = [
      n.model,
      subagentDuration(n.durationMs, locale),
      agentMapTokens(n.tokens, locale),
    ].join(" · ");
    const body = (
      <>
        <span className="cb-amap-node-line">
          <StatusDot status={n.status} />
          <span className="cb-amap-node-name" data-part="agent-node-name">
            {n.description}
          </span>
        </span>
        <span className="cb-amap-node-meta" data-part="agent-node-meta">
          {meta}
        </span>
      </>
    );
    const title = `${n.description}\n${meta}`;
    // the root is the conversation itself: it has no summary to open and is never selected
    if (depth === 0) {
      return (
        <div
          className="cb-amap-node"
          data-part="agent-node"
          data-id={n.id}
          data-depth={depth}
          data-root="true"
          title={title}
        >
          {body}
        </div>
      );
    }
    return (
      <button
        type="button"
        className="cb-amap-node"
        data-part="agent-node"
        data-id={n.id}
        data-depth={depth}
        aria-current={n.id === selectedId ? "true" : undefined}
        title={title}
        onClick={() => onOpen(n.id)}
      >
        {body}
      </button>
    );
  };

  const branch = (n: AgentMapNode, depth: number): JSX.Element => (
    <div className="cb-amap-branch" data-part="agent-branch">
      {node(n, depth)}
      {n.children.length > 0 ? (
        <div className="cb-amap-kids" data-part="agent-kids">
          {n.children.map((c) => (
            <div key={c.id} className="cb-amap-kid">
              {branch(c, depth + 1)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  const backgroundId = useId();
  const backgroundLabel = fillCopy(t("agentMap.background"), { n: background.length });
  return (
    <div className="cb-amap" data-part="agent-map-body">
      <p className="cb-amap-count" data-part="agent-map-count">
        {count}
      </p>
      <section
        className="cb-amap-canvas"
        data-part="agent-map"
        data-columns={depthOf(root)}
        aria-label={t("agentMap.canvas")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region the keyboard must reach
        tabIndex={0}
      >
        {branch(root, 0)}
        {background.length > 0 ? (
          <section
            className="cb-amap-background"
            data-part="agent-background"
            aria-labelledby={backgroundId}
          >
            <h3 className="cb-amap-background-head" id={backgroundId}>
              {backgroundLabel}
            </h3>
            <TaskRows tasks={background} now={clock} />
          </section>
        ) : null}
      </section>
      <ul className="cb-amap-legend" data-part="agent-legend" aria-label={t("agentMap.legend")}>
        {STATUSES.map((s) => (
          <li key={s} className="cb-amap-legend-item">
            <span className="cb-amap-dot" data-status={s} aria-hidden="true" />
            {t(`agentMap.status.${s}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Levels 2 and 3 ──────────────────────────────────────────────────────────

/** One tool call of level 2: the tool name and its display summary. */
export type AgentToolCallRow = {
  id: string;
  /** The tool name ("Bash", "Read"). */
  tool: string;
  /** The display summary (`Bash` description, `Read` path, …). */
  summary: string;
  running: boolean;
  /** Epoch ms; the running call's clock counts from it. */
  startedAt?: number;
  /** A range after the summary ("第 1–180 行"). */
  range?: string;
};

type Spawner = { id: string; label: string };

/** A template with one `{parent}` slot, the slot filled with a node. */
function withParent(template: string, parent: ReactNode): ReactNode {
  const at = template.indexOf("{parent}");
  if (at < 0) return template;
  return (
    <>
      {template.slice(0, at)}
      {parent}
      {template.slice(at + "{parent}".length)}
    </>
  );
}

/** The spawning agent: a link to its node, plain text when nothing opens it. */
function ParentLink({
  spawnedBy,
  onOpen,
}: {
  spawnedBy: Spawner;
  onOpen?: ((id: string) => void) | undefined;
}): JSX.Element {
  if (!onOpen) return <>{spawnedBy.label}</>;
  return (
    <button
      type="button"
      className="cb-amap-parent"
      data-part="agent-parent"
      onClick={() => onOpen(spawnedBy.id)}
    >
      {spawnedBy.label}
    </button>
  );
}

/**
 * "运行中 · 财务助手 · opus 5.5 · 后台" and "16分25秒 · 266.5k tokens"; a foreground agent (a fork
 * skill's child) has no "后台".
 */
function useMeta(
  node: AgentMapNode,
  agentType: string,
  inBackground: boolean,
): { kind: string; cost: string } {
  const t = useDesignT();
  const locale = useDesignLocale();
  return {
    kind: [
      t(`agentMap.status.${node.status}`),
      agentType,
      node.model,
      inBackground ? t("agentMap.inBackground") : "",
    ]
      .filter((s) => s !== "")
      .join(" · "),
    cost: [subagentDuration(node.durationMs, locale), agentMapTokens(node.tokens, locale)].join(
      " · ",
    ),
  };
}

/** A collapsible section of level 2: chevron, title, count. */
function DetailSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const name = count === undefined ? title : `${title} ${count}`;
  return (
    <div
      className="cb-amap-section"
      data-part="agent-section"
      data-open={open ? "true" : undefined}
    >
      <button
        type="button"
        className="cb-amap-section-head"
        data-part="agent-section-head"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        <span>{title}</span>
        {count !== undefined ? <span className="cb-amap-section-count">{count}</span> : null}
      </button>
      {open ? (
        <section id={id} className="cb-amap-section-body" aria-label={name}>
          {children}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Stop (`danger`) while the agent runs; while a stop is under way the Button's loading state
 * (spinner, disabled, `aria-busy`), so it cannot be pressed again and does not disappear.
 */
function StopButton({
  onStop,
  stopping,
  density,
}: {
  onStop: (() => void) | undefined;
  stopping: boolean;
  density?: "dense";
}): JSX.Element | null {
  const t = useDesignT();
  if (!onStop && !stopping) return null;
  return (
    <Button
      variant="danger"
      {...(density ? { density } : {})}
      loading={stopping}
      {...(onStop && !stopping ? { onClick: onStop } : {})}
    >
      {t("agentMap.stop")}
    </Button>
  );
}

export type AgentDetailProps = {
  node: AgentMapNode;
  agentType: string;
  /**
   * The agent runs in the background (default); a fork skill's child is foreground and its kind
   * line has no "后台".
   */
  inBackground?: boolean;
  /** The agent that dispatched this one (a link to its node). */
  spawnedBy: Spawner;
  /** The agent's latest text. */
  latestText: string;
  /** The dispatch prompt. */
  task: string;
  /** The agent's own background tasks. */
  background: AgentMapBackground[];
  /** In call order, oldest first: listed newest first. */
  toolCalls: AgentToolCallRow[];
  onBack(): void;
  onClose(): void;
  onOpenParent(id: string): void;
  onOpenTranscript(): void;
  /** Absent: the agent has finished and "Open transcript" fills the footer. */
  onStop?: () => void;
  /**
   * A stop is under way (from the click until the agent's terminal event, or the request fails):
   * Stop stays, in the Button's loading state (disabled, busy), even without `onStop`.
   */
  stopping?: boolean;
  /** The clock for the running call and tasks (default: the time now, ticking while one runs). */
  now?: number;
};

/**
 * Level 2 of the agent map (§6.16.28): one agent's summary, live at the granularity of tool
 * summaries. The head (back, status, description, close; kind, spawner and cost lines), the
 * latest text, the collapsible task, background tasks and tool calls (newest first, the running
 * one with a pulsing dot and a clock), and the footer: "Open transcript" and, while running, Stop.
 */
export function AgentDetail({
  node,
  agentType,
  inBackground = true,
  spawnedBy,
  latestText,
  task,
  background,
  toolCalls,
  onBack,
  onClose,
  onOpenParent,
  onOpenTranscript,
  onStop,
  stopping = false,
  now,
}: AgentDetailProps): JSX.Element {
  const t = useDesignT();
  const locale = useDesignLocale();
  const meta = useMeta(node, agentType, inBackground);
  const clock = useClock(
    toolCalls.some((c) => c.running) || background.some((b) => b.status === "running"),
    now,
  );
  const parent = <ParentLink spawnedBy={spawnedBy} onOpen={onOpenParent} />;
  return (
    <>
      <AgentMapHead
        title={node.description}
        status={node.status}
        onBack={onBack}
        onClose={onClose}
        meta={
          <>
            <p className="cb-amap-meta" data-part="agent-meta">
              {meta.kind}
            </p>
            <p className="cb-amap-meta" data-part="agent-spawned-by">
              {withParent(t("agentMap.spawnedBy"), parent)}
            </p>
            <p className="cb-amap-meta" data-part="agent-meta">
              {meta.cost}
            </p>
          </>
        }
      />
      <div className="cb-amap-detail" data-part="agent-detail">
        {latestText !== "" ? (
          <p className="cb-amap-latest" data-part="agent-latest">
            {latestText}
          </p>
        ) : null}
        <DetailSection title={t("agentMap.section.task")} defaultOpen={false}>
          <p className="cb-amap-prompt" data-part="agent-prompt">
            {task}
          </p>
        </DetailSection>
        <DetailSection
          title={t("agentMap.section.background")}
          count={background.length}
          defaultOpen={false}
        >
          <TaskRows tasks={background} now={clock} />
        </DetailSection>
        <DetailSection
          title={t("agentMap.section.toolCalls")}
          count={toolCalls.length}
          defaultOpen={true}
        >
          <ul className="cb-amap-calls">
            {[...toolCalls].reverse().map((c) => (
              <li
                key={c.id}
                className="cb-amap-call"
                data-part="agent-call"
                data-running={c.running ? "true" : undefined}
              >
                <span className="cb-amap-call-slot">
                  {c.running ? <StatusDot status="running" /> : null}
                </span>
                <span className="cb-amap-call-tool" data-part="agent-call-tool">
                  {c.tool}
                </span>
                <span className="cb-amap-call-summary" data-part="agent-call-summary">
                  {c.summary}
                </span>
                {c.range !== undefined ? (
                  <span className="cb-amap-call-end" data-part="agent-call-range">
                    {c.range}
                  </span>
                ) : null}
                {c.running && c.startedAt !== undefined ? (
                  // a ticking clock: hidden from screen readers so the live list does not chatter
                  <span
                    className="cb-amap-call-end"
                    data-part="agent-call-clock"
                    aria-hidden="true"
                  >
                    {subagentDuration(clock - c.startedAt, locale)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      </div>
      <div className="cb-amap-foot" data-part="agent-detail-foot">
        <Button onClick={onOpenTranscript}>{t("agentMap.openTranscript")}</Button>
        <StopButton onStop={onStop} stopping={stopping} />
      </div>
    </>
  );
}

export type TranscriptFrameProps = {
  node: AgentMapNode;
  agentType: string;
  /**
   * The agent runs in the background (default); a fork skill's child is foreground and its kind
   * line has no "后台".
   */
  inBackground?: boolean;
  spawnedBy: Spawner;
  /** Opens the spawning agent's node (level 2); absent: its name is plain text. */
  onOpenParent?: (id: string) => void;
  /** Context use, 0–100, shown in the status line while known. */
  contextPercent?: number;
  onBack(): void;
  onClose(): void;
  /** Absent: the agent has finished (no Stop). */
  onStop?: () => void;
  /** A stop is under way: Stop stays, in the Button's loading state (as {@link AgentDetail}). */
  stopping?: boolean;
  /** The thread: the conversation's timeline components, built like every timeline. */
  children: ReactNode;
};

/**
 * Level 3 of the agent map (§6.16.28): the agent's transcript as the conversation page draws its
 * thread, framed by the head (one meta line) and, instead of a composer, a status line with the
 * context use and Stop (none when it has neither).
 */
export function TranscriptFrame({
  node,
  agentType,
  inBackground = true,
  spawnedBy,
  onOpenParent,
  contextPercent,
  onBack,
  onClose,
  onStop,
  stopping = false,
  children,
}: TranscriptFrameProps): JSX.Element {
  const t = useDesignT();
  const meta = useMeta(node, agentType, inBackground);
  const stop = onStop !== undefined || stopping;
  return (
    <>
      <AgentMapHead
        title={node.description}
        status={node.status}
        onBack={onBack}
        onClose={onClose}
        meta={
          <p className="cb-amap-meta" data-part="agent-meta">
            {`${meta.kind} · `}
            {withParent(
              t("agentMap.spawnedBy"),
              <ParentLink spawnedBy={spawnedBy} onOpen={onOpenParent} />,
            )}
            {` · ${meta.cost}`}
          </p>
        }
      />
      {/* a pane, like RightPanel: the thread renders exactly as in the main chat (spec §1) */}
      <div className="cb-amap-transcript" data-part="agent-transcript">
        <BoxScope kind={null}>
          <div className="cb-conv-thread" data-part="thread">
            {children}
          </div>
        </BoxScope>
      </div>
      {contextPercent !== undefined || stop ? (
        <div className="cb-amap-status" data-part="agent-transcript-status">
          {contextPercent !== undefined ? (
            <span data-part="agent-context">
              {fillCopy(t("agentMap.context"), { n: Math.round(contextPercent) })}
            </span>
          ) : null}
          <StopButton onStop={onStop} stopping={stopping} density="dense" />
        </div>
      ) : null}
    </>
  );
}
