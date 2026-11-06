"use client";

import {
  AgentDetail,
  type AgentMapBackground,
  AgentMapDialog,
  type AgentMapNode,
  type AgentMapStatus,
  AgentMapTree,
  type AgentToolCallRow,
  SkeletonBars,
  TranscriptFrame,
  UserBubble,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";
import type { ProviderModels } from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import {
  type AgentTreeNode,
  abortRun,
  type BackgroundTaskView,
  type ConversationEvent,
  type ModelRef,
} from "../../lib/conversations";
import { modelLabel } from "../../lib/extension-label";
import { targetName } from "../../lib/models";
import { retryOnMountOf } from "../../lib/query/client";
import {
  agentTreeQuery,
  backgroundTasksQuery,
  hasBackgroundTasks,
  modelsQuery,
} from "../../lib/query/conversation";
import { keys as queryKeys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useWhoWaits } from "../../lib/query/who-waits";
import type { RightTarget } from "../../lib/right-area";
import {
  buildEventTimeline,
  latestUsage,
  type TimelineEntry,
  toolKeysOf,
  usedTokens,
  withDrafts,
} from "../../lib/timeline";
import { useToolInfo } from "../../lib/tool-info";
import { toolLabelText } from "../../lib/tool-label";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { taskItem } from "./BackgroundSection";
import { Thread } from "./Thread";
import { useConversation } from "./useConversation";

/** A tree status as the map's dot: a finished agent is completed, a queued one already works. */
function statusOf(s: AgentTreeNode["status"]): AgentMapStatus {
  switch (s) {
    case "idle":
    case "completed":
      return "completed";
    case "queued":
    case "running":
      return "running";
    case "waiting":
    case "failed":
    case "aborted":
      return s;
  }
}

/**
 * The agent tree (`GET …/agent-tree`) as the map's nodes (agent map spec §9.2): `idle` reads as
 * completed, the model as `provider / model` (with the providers' display names when given), an
 * untitled root as `untitled`.
 */
export function agentTreeNodes(
  tree: AgentTreeNode,
  locale: "zh" | "en",
  opts: { untitled?: string; providers?: ProviderModels[] | undefined } = {},
): AgentMapNode {
  const model = (m: AgentTreeNode["model"]) =>
    m === null
      ? "—"
      : opts.providers
        ? targetName(opts.providers, m, locale)
        : modelLabel({ name: m.provider }, m.model, locale);
  const walk = (n: AgentTreeNode, root: boolean): AgentMapNode => ({
    id: n.id,
    description: root && n.description === "" ? (opts.untitled ?? "") : n.description,
    model: model(n.model),
    durationMs: n.durationMs,
    tokens: n.tokens,
    status: statusOf(n.status),
    children: n.children.map((c) => walk(c, false)),
  });
  return walk(tree, true);
}

/** A node of the map's nodes and the one that dispatched it (null for the root). */
function locate(
  root: AgentMapNode,
  id: string,
): { node: AgentMapNode; parent: AgentMapNode | null } | null {
  const walk = (
    n: AgentMapNode,
    parent: AgentMapNode | null,
  ): { node: AgentMapNode; parent: AgentMapNode | null } | null => {
    if (n.id === id) return { node: n, parent };
    for (const c of n.children) {
      const found = walk(c, n);
      if (found) return found;
    }
    return null;
  };
  return walk(root, null);
}

/** The names of the map's nodes, by id (a parent message's sender in a transcript). */
function nodeNames(root: AgentMapNode): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  const walk = (n: AgentMapNode) => {
    m.set(n.id, n.description);
    n.children.forEach(walk);
  };
  walk(root);
  return m;
}

/** The sub-agent types of the tree, by id (the map's nodes carry none). */
function agentTypes(root: AgentTreeNode): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  const walk = (n: AgentTreeNode) => {
    if (n.agentType !== null) m.set(n.id, n.agentType);
    n.children.forEach(walk);
  };
  walk(root);
  return m;
}

const NO_TASKS: AgentMapBackground[] = [];
const NONE_STOPPING: ReadonlySet<string> = new Set();

/**
 * The agent map dialog of a root conversation (agent map spec §9), opened by the `#agents…`
 * hash: level 1 is the tree with the root's own background tasks under its column; a node opens
 * that agent's summary (`#agents=<id>`, level 2), whose "Open transcript" opens its transcript
 * (`#agents=<id>/transcript`, level 3). An id the tree does not hold (or the root's own) shows the
 * tree. Closing it clears the hash.
 */
export function AgentMap({
  orgId,
  target,
  root,
  failed,
  tasks,
  untitled,
  contextWindowOf,
  reasoningOf,
  onNavigate,
}: {
  orgId: string;
  target: Extract<RightTarget, { kind: "agents" }>;
  /** The tree; undefined while it loads (skeleton bars). */
  root: AgentTreeNode | undefined;
  /** The tree's read failed (and nothing is cached). */
  failed: boolean;
  /** The background tasks of the conversation and its sub-agents (the root's are drawn). */
  tasks: readonly BackgroundTaskView[] | undefined;
  /** The root's name while the conversation has no title. */
  untitled: string;
  contextWindowOf(m: ModelRef): number | undefined;
  reasoningOf(m: ModelRef): boolean | undefined;
  onNavigate(t: RightTarget | null): void;
}) {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const modelsQ = modelsQuery(orgId);
  const providers = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) }).data
    ?.providers;
  const nodes = useMemo(
    () => (root ? agentTreeNodes(root, locale, { untitled, providers }) : undefined),
    [root, locale, untitled, providers],
  );
  const types = useMemo(() => (root ? agentTypes(root) : new Map<string, string>()), [root]);
  const names = useMemo(() => (nodes ? nodeNames(nodes) : new Map<string, string>()), [nodes]);
  const background = useMemo(
    () =>
      tasks
        ? tasks.filter((t) => t.subagentId === null).map((t) => taskItem(t, NONE_STOPPING))
        : NO_TASKS,
    [tasks],
  );
  const close = (open: boolean) => {
    if (!open) onNavigate(null);
  };
  const found =
    nodes && target.id !== undefined && target.id !== nodes.id ? locate(nodes, target.id) : null;
  if (nodes && found?.parent) {
    const { node, parent } = found;
    const transcript = target.transcript === true;
    return (
      <AgentMapDialog open level={transcript ? "transcript" : "detail"} onOpenChange={close}>
        <AgentLevel
          key={node.id}
          orgId={orgId}
          rootId={nodes.id}
          node={node}
          agentType={types.get(node.id) ?? ""}
          spawnedBy={{ id: parent.id, label: parent.description }}
          names={names}
          transcript={transcript}
          contextWindowOf={contextWindowOf}
          reasoningOf={reasoningOf}
          onNavigate={onNavigate}
        />
      </AgentMapDialog>
    );
  }
  return (
    <AgentMapDialog open level="tree" onOpenChange={close}>
      {nodes ? (
        <AgentMapTree
          root={nodes}
          background={background}
          {...(target.id !== undefined ? { selectedId: target.id } : {})}
          onOpen={(id) => onNavigate(id === nodes.id ? { kind: "agents" } : { kind: "agents", id })}
        />
      ) : failed ? (
        <FormError message={t("agentMapFailed")} />
      ) : (
        <SkeletonBars />
      )}
    </AgentMapDialog>
  );
}

/** The newest prose of the log: the agent's latest text. */
function latestText(entries: readonly TimelineEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.kind === "prose") return e.text;
  }
  return "";
}

/** The agent's own status from its log once it has one (the tree is read again only now and then). */
function liveStatus(
  tree: AgentMapStatus,
  log: { loading: boolean; running: boolean; waiting: boolean; events: ConversationEvent[] },
): AgentMapStatus {
  if (log.loading) return tree;
  if (log.waiting) return "waiting";
  if (log.running) return "running";
  for (let i = log.events.length - 1; i >= 0; i--) {
    const e = log.events[i];
    if (e?.type === "run_finished") return "completed";
    if (e?.type === "run_failed") return "failed";
    if (e?.type === "run_aborted") return "aborted";
  }
  return tree;
}

/** The tool calls of a timeline in call order, as level 2 lists them. */
function toolCallRows(
  entries: readonly TimelineEntry[],
  range: (lines: { from: number; to: number }) => string,
): AgentToolCallRow[] {
  const rows: AgentToolCallRow[] = [];
  for (const e of entries) {
    if (e.kind === "tools") {
      for (const r of e.rows) {
        const row = r.row;
        rows.push({
          id: row.id,
          tool: toolLabelText({
            name: row.name,
            ...(row.tool !== undefined ? { tool: row.tool } : {}),
          }),
          summary: row.description ?? row.keyArg ?? "",
          running: row.status === "running" || row.status === "pending",
          ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
          ...(r.lines ? { range: range(r.lines) } : {}),
        });
      }
    } else if (e.kind === "subagents") {
      for (const { row } of e.rows) {
        rows.push({
          id: row.id,
          tool: "Agent",
          summary: row.description,
          running: row.status === "queued" || row.status === "running" || row.status === "waiting",
          ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
        });
      }
    }
  }
  return rows;
}

/**
 * Levels 2 and 3 of one sub-agent (agent map spec §9.3, §9.4), both from its own log and stream
 * (any depth: the kernel lets the root's owner read every agent of the tree): the summary (latest
 * text, task, background tasks, tool calls newest first, Stop while it runs) and the transcript (the
 * conversation page's thread, read-only, no composer). Stop aborts this agent and its descendants.
 */
function AgentLevel({
  orgId,
  rootId,
  node: treeNode,
  agentType,
  spawnedBy,
  names,
  transcript,
  contextWindowOf,
  reasoningOf,
  onNavigate,
}: {
  orgId: string;
  rootId: string;
  node: AgentMapNode;
  agentType: string;
  spawnedBy: { id: string; label: string };
  /** The tree's agents' names by id. */
  names: ReadonlyMap<string, string>;
  transcript: boolean;
  contextWindowOf(m: ModelRef): number | undefined;
  reasoningOf(m: ModelRef): boolean | undefined;
  onNavigate(t: RightTarget | null): void;
}) {
  const t = useTranslations("chat");
  const locale = useLocale() === "zh" ? "zh" : "en";
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const id = treeNode.id;
  const child = useConversation(orgId, id);
  const keys = useMemo(() => toolKeysOf(child.events), [child.events]);
  const info = useToolInfo(orgId, id, keys);
  const whoWaits = useWhoWaits(orgId, child.events);
  const base = useMemo(
    () =>
      buildEventTimeline(child.events, info, locale, {
        progress: child.state.progress,
        whoWaits,
        agentName: (n) => names.get(n),
      }),
    [child.events, info, locale, child.state.progress, whoWaits, names],
  );
  const entries = useMemo(
    () => (transcript ? withDrafts(base, child.state.drafts) : base.entries),
    [transcript, base, child.state.drafts],
  );
  const bgEnabled = useMemo(() => hasBackgroundTasks(child.events), [child.events]);
  const bgQ = backgroundTasksQuery(orgId, id);
  const bg = useQuery({ ...bgQ, enabled: bgEnabled, retryOnMount: retryOnMountOf(bgQ.queryKey) });
  const background = useMemo(
    () =>
      (bg.data ?? [])
        .filter((x) => x.subagentId === null)
        .map((x) => taskItem(x, NONE_STOPPING))
        // the list is newest first; the section lists them in start order
        .reverse(),
    [bg.data],
  );
  const status = liveStatus(treeNode.status, child);
  const node: AgentMapNode = { ...treeNode, status };
  // a fork skill's child (its task carries the invocation) runs in the foreground
  const inBackground = !child.events.some(
    (e) =>
      e.type === "user_message" &&
      e.payload.dispatch !== undefined &&
      e.payload.skill !== undefined,
  );
  const stopMutation = useAppMutation({
    fn: () => abortRun(orgId, id),
    // the tree shows the stop as soon as the kernel has it; the agent's own log is read again
    // (a grandchild's terminal event reaches no stream of the page but its own)
    invalidates: () => [
      agentTreeQuery(orgId, rootId).queryKey,
      queryKeys.org(orgId).conversation(id).row(),
      queryKeys.org(orgId).conversation(id).events(),
    ],
  });
  const { mutate } = stopMutation;
  const stop = useCallback(
    () =>
      mutate(undefined, {
        onError: (e) => {
          // the run just ended: its terminal event arrives through the stream
          if (!(e instanceof ApiClientError && e.code === "run.not_active"))
            toast.error(errorMessage(e));
        },
      }),
    [mutate, toast, errorMessage],
  );
  const active = status === "running" || status === "waiting";
  const onStop = active && !stopMutation.isPending ? { onStop: stop } : {};
  const openParent = (pid: string) =>
    onNavigate(pid === rootId ? { kind: "agents" } : { kind: "agents", id: pid });
  const close = () => onNavigate(null);

  if (transcript) {
    const usage = latestUsage(child.events);
    const window_ = usage
      ? contextWindowOf({ provider: usage.provider, model: usage.model })
      : undefined;
    const pct = usage && window_ && window_ > 0 ? (usedTokens(usage) / window_) * 100 : undefined;
    return (
      <TranscriptFrame
        node={node}
        agentType={agentType}
        inBackground={inBackground}
        spawnedBy={spawnedBy}
        onOpenParent={openParent}
        {...(pct !== undefined ? { contextPercent: pct } : {})}
        onBack={() => onNavigate({ kind: "agents", id })}
        onClose={close}
        {...onStop}
      >
        {child.loading ? (
          <SkeletonBars />
        ) : (
          <Thread
            live={false}
            orgId={orgId}
            conversationId={id}
            entries={entries}
            info={info}
            reasoningOf={reasoningOf}
            onOpenAgent={(sub) => onNavigate({ kind: "agents", id: sub })}
            onOpenAgentMap={() => onNavigate({ kind: "agents" })}
            renderTask={(e) => <UserBubble text={e.text} sender={spawnedBy.label} />}
          />
        )}
      </TranscriptFrame>
    );
  }
  return (
    <AgentDetail
      node={node}
      agentType={agentType}
      inBackground={inBackground}
      spawnedBy={spawnedBy}
      latestText={latestText(entries)}
      task={
        entries.find((e): e is Extract<TimelineEntry, { kind: "task" }> => e.kind === "task")
          ?.text ?? ""
      }
      background={background}
      toolCalls={toolCallRows(entries, (lines) => t("toolLines", lines))}
      onBack={() => onNavigate({ kind: "agents" })}
      onClose={close}
      onOpenParent={openParent}
      onOpenTranscript={() => onNavigate({ kind: "agents", id, transcript: true })}
      {...onStop}
    />
  );
}
