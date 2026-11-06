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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ProviderModels } from "../../lib/agents";
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
  catchUpEvents,
  hasBackgroundTasks,
  modelsQuery,
} from "../../lib/query/conversation";
import { keys as queryKeys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useWhoWaits } from "../../lib/query/who-waits";
import type { RightTarget } from "../../lib/right-area";
import { useStopUnderWay } from "../../lib/stop";
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
 * untitled root as `untitled`. The tree reports a run that ended on its step, time or token limit
 * as `idle` (the run completed); `finishes` (the root's own children's latest
 * `subagent_finished`, which the stream shows as failed) corrects an ended node. A deeper agent's
 * end is only in its parent's log, which level 1 does not read: its node keeps the tree's word
 * until its level 2 (its own log) is open.
 */
export function agentTreeNodes(
  tree: AgentTreeNode,
  locale: "zh" | "en",
  opts: {
    untitled?: string;
    providers?: ProviderModels[] | undefined;
    finishes?: ReadonlyMap<string, AgentMapStatus>;
  } = {},
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
    status:
      n.status === "idle" || n.status === "completed"
        ? (opts.finishes?.get(n.id) ?? "completed")
        : statusOf(n.status),
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
  finishes,
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
  /** How the root's own children's latest runs ended, by id (the stream's words). */
  finishes?: ReadonlyMap<string, AgentMapStatus>;
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
    () =>
      root
        ? agentTreeNodes(root, locale, {
            untitled,
            providers,
            ...(finishes ? { finishes } : {}),
          })
        : undefined,
    [root, locale, untitled, providers, finishes],
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
      <AgentMapDialog
        open
        level={transcript ? "transcript" : "detail"}
        view={`${transcript ? "transcript" : "detail"}:${node.id}`}
        // Esc goes back one level, as the head's back button does
        onBack={() => onNavigate(transcript ? { kind: "agents", id: node.id } : { kind: "agents" })}
        onOpenChange={close}
      >
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
    <AgentMapDialog open level="tree" view="tree" onOpenChange={close}>
      {nodes ? (
        <AgentMapTree
          root={nodes}
          background={background}
          // the root opens nothing and is never selected
          {...(target.id !== undefined && target.id !== nodes.id ? { selectedId: target.id } : {})}
          onOpen={(id) => onNavigate({ kind: "agents", id })}
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

/** Run ends the stream shows as failed (`subagent_finished` with a limit's status). */
const LIMIT_ENDS = new Set(["max_steps", "max_duration", "budget"]);

/** What an agent's own log says of its status. */
export type LogWord =
  /** No word: the log is loading, or no run of it has ended yet (a queued first run). */
  | { kind: "tree" }
  /** The log's own word: a run is open (running, waiting), or the latest run's end. */
  | { kind: "log"; status: AgentMapStatus }
  /**
   * A message or a background task's end (`seq`) after the latest run's end (`ended`), with no
   * run started since: a restart or a wake that may be queued. Only a tree read after `seq` was
   * seen can say so; until then the log's end stands.
   */
  | { kind: "restart"; seq: number; ended: AgentMapStatus };

/** A terminal event's word, or null for any other event. */
function endOf(e: ConversationEvent): AgentMapStatus | null {
  if (e.type === "run_finished") return LIMIT_ENDS.has(e.payload.reason) ? "failed" : "completed";
  if (e.type === "run_failed") return "failed";
  if (e.type === "run_aborted") return "aborted";
  return null;
}

/** What the agent's log says of its status (the tree is read again only now and then). */
export function logWord(log: {
  loading: boolean;
  running: boolean;
  waiting: boolean;
  events: readonly ConversationEvent[];
}): LogWord {
  if (log.loading) return { kind: "tree" };
  if (log.waiting) return { kind: "log", status: "waiting" };
  if (log.running) return { kind: "log", status: "running" };
  let restart: number | null = null;
  for (let i = log.events.length - 1; i >= 0; i--) {
    const e = log.events[i];
    if (e === undefined) continue;
    if (restart === null && (e.type === "user_message" || e.type === "background_task_finished"))
      restart = e.seq;
    const ended = endOf(e);
    if (ended !== null)
      return restart === null
        ? { kind: "log", status: ended }
        : { kind: "restart", seq: restart, ended };
  }
  return { kind: "tree" };
}

/**
 * The agent's status (AC5: one source per moment, so the head and Stop never flip): the log's
 * word once it has one; the tree's while the log has none; after a run's end followed by a
 * message or a task's end, the tree's only when it was read after that event was seen
 * (`treeFresh`), never an older active word.
 */
export function liveStatus(
  tree: AgentMapStatus,
  word: LogWord,
  treeFresh: boolean,
): AgentMapStatus {
  if (word.kind === "tree") return tree;
  if (word.kind === "log") return word.status;
  return treeFresh ? tree : word.ended;
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
  const qc = useQueryClient();
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
  // The tree's reads (this observer only listens: the map's own query reads it).
  const treeQ = useMemo(() => agentTreeQuery(orgId, rootId), [orgId, rootId]);
  // How many answers the tree's query has had (an equal answer counts too), from the cache: the
  // map's own query reads it.
  const subscribe = useCallback((cb: () => void) => qc.getQueryCache().subscribe(cb), [qc]);
  const readCount = useCallback(
    () => qc.getQueryState(treeQ.queryKey)?.dataUpdateCount ?? 0,
    [qc, treeQ.queryKey],
  );
  const treeReads = useSyncExternalStore(subscribe, readCount, readCount);
  const word = logWord(child);
  const restartSeq = word.kind === "restart" ? word.seq : null;
  // When a restart (or wake) event is first seen: the tree's read count then. The read in flight
  // may have started before the event; invalidating cancels it and reads again, so only a read
  // counted after this one can speak for the restart.
  const [restartSeen, setRestartSeen] = useState<{ seq: number; reads: number } | null>(null);
  useEffect(() => {
    if (restartSeq === null) return;
    // counted now, before the invalidation below can land an answer
    const reads = readCount();
    setRestartSeen((r) => (r?.seq === restartSeq ? r : { seq: restartSeq, reads }));
    void qc.invalidateQueries({ queryKey: treeQ.queryKey });
  }, [restartSeq, qc, treeQ.queryKey, readCount]);
  const treeFresh =
    restartSeen !== null && restartSeen.seq === restartSeq && treeReads > restartSeen.reads;
  const status = liveStatus(treeNode.status, word, treeFresh);
  const node: AgentMapNode = { ...treeNode, status };
  // a fork skill's child (its task carries the invocation) runs in the foreground
  const inBackground = !child.events.some(
    (e) =>
      e.type === "user_message" &&
      e.payload.dispatch !== undefined &&
      e.payload.skill !== undefined,
  );
  const active = status === "running" || status === "waiting";
  // A merged re-read of what the stop changes: the child's log from its cached end (never a
  // wholesale refetch: an event the stream appends meanwhile survives), its row and the tree.
  const resync = useCallback(
    () =>
      Promise.all([
        catchUpEvents(qc, orgId, id),
        qc.invalidateQueries({ queryKey: treeQ.queryKey }),
        qc.invalidateQueries({ queryKey: queryKeys.org(orgId).conversation(id).row() }),
      ]),
    [qc, orgId, id, treeQ.queryKey],
  );
  // A stop under way: from the click until the agent's run ends in its log, the request fails,
  // or the bounded fallback (a re-read after STOP_FALLBACK_MS) lets Stop be pressed again.
  const stopState = useStopUnderWay(child.events, resync);
  const stopping = stopState.requested && active;
  const { release } = stopState;
  const stopMutation = useAppMutation({
    fn: () => abortRun(orgId, id),
    // the tree shows the stop as soon as the kernel has it; the agent's terminal event comes
    // through its own stream, open at this level
    invalidates: () => [treeQ.queryKey, queryKeys.org(orgId).conversation(id).row()],
    // at the hook level: the report survives the level being closed while the request runs
    onError: (e) => {
      release();
      if (e.code === "run.not_active") {
        // Nothing in this subtree runs: what the page shows is stale. Read it again, so the
        // status settles to the kernel's and Stop goes.
        void resync();
        return;
      }
      // The browser's own reason ("Failed to fetch", "Load failed") for diagnosis.
      console.warn("agent map: stop failed", e.code, e);
      toast.error(t("stopFailed", { reason: errorMessage(e) }));
    },
  });
  const { mutate } = stopMutation;
  const { begin } = stopState;
  const stop = useCallback(() => {
    begin();
    mutate(undefined);
  }, [begin, mutate]);
  const onStop = active && !stopping ? { onStop: stop } : {};
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
        stopping={stopping}
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
            onOpenAgent={(sub, toTranscript) =>
              onNavigate({ kind: "agents", id: sub, ...(toTranscript ? { transcript: true } : {}) })
            }
            onOpenAgentMap={() => onNavigate({ kind: "agents" })}
            // its background tasks' notices open the task (the root's list holds every agent's)
            onOpenTask={(taskId) => onNavigate({ kind: "background", taskId })}
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
      stopping={stopping}
    />
  );
}
