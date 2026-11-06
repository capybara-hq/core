import * as RD from "@radix-ui/react-dialog";
import { type JSX, type ReactNode, useId } from "react";
import { IconButton } from "../controls/button";
import type { Locale } from "../i18n";
import { messages } from "../i18n";
import { Icon } from "../icons/icon";
import { useFocusReturn } from "../overlays/focus-return";
import { useDesignLocale, useDesignT } from "../provider";
import { useClock } from "./clock";
import { type BackgroundTaskItem, type BackgroundTaskStatus, subagentDuration } from "./subagents";
import { fillCopy } from "./tool-copy";

// The agent map (spec §6.16.28, agent map spec §9): a dialog over the conversation page whose
// level 1 is the tree of agents, columns by depth with elbow connectors, every node one fixed
// height, status only as a dot (with a legend), and the root's background tasks under its column.

export type AgentMapStatus = "running" | "waiting" | "completed" | "failed" | "aborted";

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

/** The dialog width of each level: the tree, one agent's summary, its transcript. */
const LEVEL_SIZE = { tree: 1100, detail: 760, transcript: 1060 } as const;

const STATUSES: AgentMapStatus[] = ["running", "waiting", "completed", "failed", "aborted"];

/** "392.7k tokens", "950 tokens", "1.3M tokens". */
export function agentMapTokens(n: number, locale: Locale): string {
  const v = Math.max(0, Math.round(n));
  const short =
    v < 1000
      ? String(v)
      : v < 1_000_000
        ? `${(Math.round(v / 100) / 10).toFixed(1)}k`
        : `${(Math.round(v / 100_000) / 10).toFixed(1)}M`;
  return fillCopy(messages[locale]["agentMap.tokens"], { n: short });
}

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

function StatusDot({ status }: { status: AgentMapStatus }): JSX.Element {
  const t = useDesignT();
  return (
    <span
      className="cb-amap-dot"
      data-part="agent-dot"
      data-status={status}
      role="img"
      aria-label={t(`agentMap.status.${status}`)}
    />
  );
}

export type AgentMapDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The level shown: the width follows it (1100 / 760 / 1060). */
  level: "tree" | "detail" | "transcript";
  /** Drawn in place, without the portal and the scrim (the reference blocks of `/dev/ui`). */
  inline?: boolean;
  children: ReactNode;
};

/**
 * The agent map's dialog frame (§6.16.28): the ordinary dialog ground, border, radius and shadow
 * (§6.7) at the level's width, a head with the title and close, and the level's content. Esc
 * closes; focus is trapped and returned.
 */
export function AgentMapDialog({
  open,
  onOpenChange,
  level,
  inline,
  children,
}: AgentMapDialogProps): JSX.Element | null {
  const t = useDesignT();
  const focusReturn = useFocusReturn();
  const close = (
    <IconButton label={t("overlay.close")} icon={<Icon name="x" size={14} />} density="dense" />
  );
  if (inline) {
    if (!open) return null;
    return (
      <div
        className="cb-dialog cb-amap-dialog"
        data-part="agent-map-dialog"
        data-size={LEVEL_SIZE[level]}
        data-inline="true"
        role="dialog"
        aria-label={t("agentMap.title")}
      >
        <div className="cb-amap-head">
          <h2 className="cb-amap-title" data-part="agent-map-title">
            {t("agentMap.title")}
          </h2>
          <IconButton
            label={t("overlay.close")}
            icon={<Icon name="x" size={14} />}
            density="dense"
            onClick={() => onOpenChange(false)}
          />
        </div>
        {children}
      </div>
    );
  }
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-scrim" />
        <RD.Content
          className="cb-dialog cb-amap-dialog"
          data-part="agent-map-dialog"
          data-size={LEVEL_SIZE[level]}
          aria-describedby={undefined}
          onOpenAutoFocus={() => focusReturn.capture()}
          onCloseAutoFocus={focusReturn.restore}
        >
          <div className="cb-amap-head">
            <RD.Title className="cb-amap-title" data-part="agent-map-title">
              {t("agentMap.title")}
            </RD.Title>
            <RD.Close asChild>{close}</RD.Close>
          </div>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
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
    return (
      <button
        type="button"
        className="cb-amap-node"
        data-part="agent-node"
        data-id={n.id}
        data-depth={depth}
        data-root={depth === 0 ? "true" : undefined}
        aria-current={n.id === selectedId ? "true" : undefined}
        title={`${n.description}\n${meta}`}
        onClick={() => onOpen(n.id)}
      >
        <span className="cb-amap-node-line">
          <StatusDot status={n.status} />
          <span className="cb-amap-node-name" data-part="agent-node-name">
            {n.description}
          </span>
        </span>
        <span className="cb-amap-node-meta" data-part="agent-node-meta">
          {meta}
        </span>
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
      <div className="cb-amap-canvas" data-part="agent-map" data-columns={depthOf(root)}>
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
            <ul className="cb-amap-background-list">
              {background.map((b) => (
                <li key={b.id} className="cb-amap-task" data-part="agent-task">
                  <StatusDot status={taskDot(b.status)} />
                  <span className="cb-amap-task-tag" data-part="agent-task-tag">
                    Bash
                  </span>
                  <span className="cb-amap-task-name">{b.description}</span>
                  <span className="cb-amap-task-time" data-part="agent-task-time">
                    {subagentDuration(
                      (b.status === "running" ? clock : (b.finishedAt ?? clock)) - b.startedAt,
                      locale,
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
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
