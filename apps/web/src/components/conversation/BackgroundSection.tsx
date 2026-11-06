"use client";

import {
  type BackgroundItem,
  type BackgroundTaskItem,
  type BackgroundTaskStatus,
  BackgroundTasks,
  PropertySection,
  RightPanel,
  type SubagentStatus,
  subagentDuration,
  subagentWaitKind,
  TaskOutputPanel,
  useNow,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { BackgroundTaskView, SubagentView } from "../../lib/conversations";
import { taskOutputPollMs, taskOutputQuery } from "../../lib/query/conversation";
import { useErrorMessage } from "../../lib/use-error-message";

const statusOf = (s: string): SubagentStatus =>
  s === "queued" || s === "running" || s === "waiting" || s === "failed" || s === "aborted"
    ? s
    : "completed";

/** A kernel task status as the design's (the same words; an unknown one reads as lost). */
const taskStatusOf = (s: string): BackgroundTaskStatus =>
  s === "running" ||
  s === "completed" ||
  s === "failed" ||
  s === "stopped" ||
  s === "timed_out" ||
  s === "lost"
    ? s
    : "lost";

const ms = (iso: string | null): number | undefined => {
  if (iso === null) return undefined;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? undefined : n;
};

/** A kernel task as the design's row (also the agent map's background rows). */
export function taskItem(t: BackgroundTaskView, stopping: ReadonlySet<string>): BackgroundTaskItem {
  const finishedAt = ms(t.finishedAt);
  return {
    kind: "task",
    id: t.id,
    description: t.description,
    status: taskStatusOf(t.status),
    startedAt: ms(t.startedAt) ?? 0,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    exitCode: t.exitCode,
    ...(t.stopping || stopping.has(t.id) ? { stopping: true } : {}),
  };
}

/**
 * The section's items, newest first: the conversation's own tasks and its sub-agents, each
 * sub-agent with its own tasks under it. A sub-agent's task whose sub-agent the list does not show
 * (yet) stands on its own.
 */
export function backgroundItems(
  views: readonly SubagentView[],
  tasks: readonly BackgroundTaskView[],
  stopping: ReadonlySet<string> = new Set(),
): BackgroundItem[] {
  const shown = new Set(views.map((v) => v.id));
  const own = tasks.filter((t) => t.subagentId === null || !shown.has(t.subagentId));
  const items: { at: number; item: BackgroundItem }[] = [
    ...own.map((t) => ({ at: ms(t.startedAt) ?? 0, item: taskItem(t, stopping) })),
    ...views.map((v) => {
      const finishedAt = ms(v.finishedAt);
      const children = tasks
        .filter((t) => t.subagentId === v.id)
        .map((t) => ({ ...taskItem(t, stopping), nested: true }));
      const item: BackgroundItem = {
        kind: "subagent",
        id: v.id,
        name: v.description || v.agentType,
        status: statusOf(v.status),
        ...(v.status === "waiting" ? { waiting: subagentWaitKind(v) } : {}),
        startedAt: ms(v.startedAt) ?? 0,
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        ...(children.length > 0 ? { tasks: children } : {}),
      };
      return { at: ms(v.startedAt) ?? 0, item };
    }),
  ];
  // stable: at the same time the conversation's tasks come first
  return items.sort((a, b) => b.at - a.at).map((x) => x.item);
}

/**
 * The "Background tasks" properties section (spec §5.3, §5.6; background Bash spec §5): the running
 * background tasks and sub-agents (a sub-agent's own tasks nested under it) with their time, each
 * stoppable and openable, then "N completed ›" opening the newest finished one. Shown only once the
 * conversation has a task or a sub-agent.
 */
export function BackgroundSection({
  views,
  tasks,
  stopping,
  onStop,
  onOpen,
}: {
  /** `GET …/subagents`, newest first. */
  views: readonly SubagentView[];
  /** `GET …/background-tasks`, newest first. */
  tasks: readonly BackgroundTaskView[];
  /** Tasks whose stop this page sent and the kernel has not answered yet. */
  stopping?: ReadonlySet<string>;
  onStop(item: { kind: "task" | "subagent"; id: string }): void;
  onOpen(item: { kind: "task" | "subagent"; id: string }): void;
}) {
  const t = useTranslations("subagents");
  const kindOf = (id: string) => (tasks.some((x) => x.id === id) ? "task" : "subagent");
  return (
    <PropertySection title={t("background")}>
      <BackgroundTasks
        items={backgroundItems(views, tasks, stopping)}
        onStop={(id) => onStop({ kind: kindOf(id), id })}
        onOpen={(id) => onOpen({ kind: kindOf(id), id })}
      />
    </PropertySection>
  );
}

/**
 * A background task's output in the right panel (`#bg-<taskId>`, background Bash spec §5): its
 * description, command, status and elapsed time, and the output's end, read again every 2 s while
 * the task runs. When the output cannot be read (409: the sandbox is suspended or gone) the panel
 * says so and shows the last lines the finish event kept.
 */
export function BackgroundTaskPanel({
  orgId,
  conversationId,
  taskId,
  task,
  loading,
  lastLines,
  stopping,
  onStop,
  onClose,
  onFullscreen,
}: {
  orgId: string;
  conversationId: string;
  taskId: string;
  /** The task from the list; undefined while the list loads or when it does not name it. */
  task: BackgroundTaskView | undefined;
  /** The list is still on its way. */
  loading: boolean;
  /** The finish event's last lines, when the log has them. */
  lastLines: string | undefined;
  /** This page's stop of the task is on its way (the task view's `stopping` counts too). */
  stopping: boolean;
  onStop(): void;
  onClose(): void;
  onFullscreen(): void;
}) {
  const t = useTranslations("background");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const errorMessage = useErrorMessage();
  const status = task === undefined ? undefined : taskStatusOf(task.status);
  const q = useQuery({
    ...taskOutputQuery(orgId, conversationId, taskId),
    enabled: task !== undefined,
    refetchInterval: taskOutputPollMs(status),
  });
  const now = useNow(status === "running" ? 1000 : 0);
  if (task === undefined || status === undefined) {
    return (
      <RightPanel
        title={t("panelTitle")}
        onClose={onClose}
        state={loading ? "loading" : "failed"}
        {...(loading ? {} : { failure: { reason: t("notFound") } })}
      />
    );
  }
  const started = ms(task.startedAt) ?? now;
  const end = status === "running" ? now : (ms(task.finishedAt) ?? now);
  const out = q.data;
  return (
    <RightPanel
      title={task.description}
      onClose={onClose}
      onFullscreen={onFullscreen}
      state={out === undefined ? (q.error !== null ? "failed" : "loading") : "ready"}
      {...(q.error !== null && out === undefined
        ? { failure: { reason: errorMessage(q.error) } }
        : {})}
      onRetry={() => void q.refetch()}
    >
      {out !== undefined ? (
        <TaskOutputPanel
          description={task.description}
          command={task.command}
          status={status}
          elapsed={subagentDuration(Math.max(0, end - started), locale)}
          text={out === null ? (lastLines ?? "") : out.text}
          source={out === null || out.source === "event" ? "event" : "sandbox"}
          stopping={task.stopping || stopping}
          onStop={onStop}
        />
      ) : null}
    </RightPanel>
  );
}
