"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  AgentTreeNode,
  ConversationEvent,
  ConversationUsage,
  SubagentToolRef,
  SubagentView,
} from "./conversations";
import { retryOnMountOf } from "./query/client";
import { agentTreeQuery, subagentsQuery, usageQuery } from "./query/conversation";
import { extensionToolKey } from "./tool-key";
import { toolLabelOfKey, toolLabelText } from "./tool-label";

/**
 * Sub-agents on the conversation page (UI refresh B Task 21, phase C §14): the parent's list
 * (`GET …/subagents`), the total tokens with sub-agents (`GET …/usage`) and the pure helpers the
 * panel and the properties section share.
 */

/** A list status that is still going (the latest child run). */
export const isActiveStatus = (s: string) => s === "queued" || s === "running" || s === "waiting";

/** How many `subagent_*` events the log holds: the list is read again when it moves. */
const subagentEventCount = (events: readonly ConversationEvent[]) =>
  events.filter(
    (e) =>
      e.type === "subagent_dispatched" ||
      e.type === "subagent_waiting" ||
      e.type === "subagent_finished",
  ).length;

/** Whether the conversation has dispatched a sub-agent (the agent map's entries show then). */
export const dispatchedAny = (events: readonly ConversationEvent[]) =>
  events.some((e) => e.type === "subagent_dispatched");

/**
 * Invalidates `queryKey` when `count` moves after the first value (the first is what the cached
 * answer stands for).
 */
function useInvalidateOn(queryKey: readonly unknown[], count: number, active: boolean) {
  const qc = useQueryClient();
  const seen = useRef(count);
  useEffect(() => {
    if (!active || seen.current === count) return;
    seen.current = count;
    void qc.invalidateQueries({ queryKey });
  }, [qc, queryKey, count, active]);
}

/**
 * The conversation's sub-agents, newest first, through the query cache: read once a sub-agent was
 * dispatched, and again on every `subagent_*` event and when stream progress arrives for a child
 * the list shows as waiting or queued (it moved on: someone decided, or it got a slot). `onLoad`
 * gets each answer (progress seeds). A failed read keeps what the log says on the rows.
 */
export function useSubagents(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
  progress: Readonly<Record<string, { step: number }>>,
  onLoad: ((views: SubagentView[]) => void) | undefined,
): { views: SubagentView[] | undefined; refresh(): void } {
  const qc = useQueryClient();
  // scans of the log: once per events change, not per render (final review I3)
  const dispatched = useMemo(() => dispatchedAny(events), [events]);
  const count = useMemo(() => subagentEventCount(events), [events]);
  // One options object (and key) per conversation, not per render: the effects below depend on the
  // key, and a new array each render re-ran them on every render, reading the list in a loop while
  // a waiting child had progress (AC5).
  const query = useMemo(() => subagentsQuery(orgId, conversationId), [orgId, conversationId]);
  const views = useQuery({
    ...query,
    enabled: dispatched,
    retryOnMount: retryOnMountOf(query.queryKey),
  }).data;
  useInvalidateOn(query.queryKey, count, dispatched);
  const load = useRef(onLoad);
  load.current = onLoad;
  // Each answer seeds the stream progress.
  useEffect(() => {
    if (views !== undefined) load.current?.(views);
  }, [views]);
  // A child shown as waiting or queued that made progress: read the list again.
  const stale = useMemo(() => {
    const keys: string[] = [];
    for (const v of views ?? []) {
      const p = progress[v.id];
      if (p !== undefined && (v.status === "waiting" || v.status === "queued"))
        keys.push(`${v.id}:${p.step}`);
    }
    return keys.join(",");
  }, [views, progress]);
  // once per new `stale` value (a child's step moved), never per render
  useEffect(() => {
    if (stale !== "") void qc.invalidateQueries({ queryKey: query.queryKey });
  }, [stale, qc, query.queryKey]);
  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: query.queryKey }),
    [qc, query.queryKey],
  );
  return { views: dispatched ? views : undefined, refresh };
}

/** Whether the log holds a wait of an agent below the conversation's own children (§7). */
export const hasNestedWait = (events: readonly ConversationEvent[]) =>
  events.some((e) => e.type === "subagent_waiting" && (e.payload.path?.length ?? 1) > 1);

/**
 * Whether the log holds a nested agent's wait whose branch (the root's child on its path) has
 * not ended since: whether it still waits, and its name, are only in the agent tree.
 */
export function hasUnresolvedNestedWait(events: readonly ConversationEvent[]): boolean {
  const open = new Set<string>();
  for (const e of events) {
    if (e.type === "subagent_waiting" && (e.payload.path?.length ?? 1) > 1) {
      const top = e.payload.path?.[0];
      if (top !== undefined) open.add(top);
    } else if (e.type === "subagent_finished") open.delete(e.payload.subagentId);
  }
  return open.size > 0;
}

/** What the timeline reads of the agent tree: each agent's name and own status. */
export type TreeLookup = {
  agentName(id: string): string | undefined;
  agentStatus(id: string): string | undefined;
};

/**
 * The agent tree as names and statuses for the conversation's timeline (agent map spec §7): read
 * only while the log holds a nested agent's wait whose branch has not ended since
 * ({@link hasUnresolvedNestedWait}); its name and whether it still waits are in the tree, not in
 * the root's log. The map's own refresh ({@link useAgentTree}) keeps it current meanwhile; after
 * that the last answer still names the agents of the log's older waits. Only a root conversation
 * (`root`) has a tree: a sub-agent's page never reads it (the API answers 404).
 */
export function useTreeLookup(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
  root: boolean,
): TreeLookup | undefined {
  const nested = useMemo(() => hasNestedWait(events), [events]);
  const unresolved = useMemo(() => hasUnresolvedNestedWait(events), [events]);
  const query = agentTreeQuery(orgId, conversationId);
  const tree = useQuery({
    ...query,
    enabled: root && unresolved,
    retryOnMount: retryOnMountOf(query.queryKey),
  }).data;
  return useMemo(() => {
    if (!root || !nested || tree === undefined) return undefined;
    const nodes = new Map<string, AgentTreeNode>();
    const walk = (n: AgentTreeNode) => {
      nodes.set(n.id, n);
      n.children.forEach(walk);
    };
    walk(tree);
    return {
      agentName: (id) => nodes.get(id)?.description || nodes.get(id)?.agentType || undefined,
      agentStatus: (id) => nodes.get(id)?.status,
    };
  }, [root, nested, tree]);
}

/** What the composer's agents chip shows (design spec §6.16.29, acceptance item AC3). */
export type AgentsSummary = {
  /** Every sub-agent the page knows of, at any depth (the root not counted). */
  count: number;
  /** Those that run (queued included). */
  running: number;
  /** Those that wait for a person. */
  waiting: number;
};

/**
 * The agents chip's numbers (AC3) from what the page reads: the conversation's own sub-agents
 * from its log and its sub-agent list (live: the list is read again on every `subagent_*` event),
 * every depth from the agent tree ({@link useAgentTree}: prefetched with the page and read again
 * on every `subagent_*` event and on a new agent's progress), the root log's waits (their `path`
 * names every agent down to the waiting one) and the stream's progress (any agent of the tree),
 * so the count never waits for a read.
 *
 * Activity follows the agent map's dot rules. A child of the conversation that waits with no
 * approval or question of its own waits for its own sub-agents: what they do counts (the tree's
 * descendants when it has them, else an open deep wait under it). An active child with nothing
 * below it that counts is working itself, counted once (fix round 1: a stale tree must not drop
 * the dot). Deeper statuses count only while their branch's top child is active by the live list:
 * the tree read last may be older than a deep agent's end, which reaches no event of the root's
 * log.
 */
export function agentsSummary(input: {
  events: readonly ConversationEvent[];
  views: readonly SubagentView[] | undefined;
  progress: Readonly<Record<string, unknown>>;
  tree: AgentTreeNode | undefined;
}): AgentsSummary {
  const ids = new Set<string>();
  /** The conversation's own children: their status, and whether they wait for a person. */
  const direct = new Map<string, { status: string; person: boolean }>();
  /**
   * Open waits of deeper agents by the branch's top child. The root's log holds no event for a
   * deep wait's answer or for a deep agent's end, so a wait stays open until the branch's top
   * child finishes (the same rule as `hasUnresolvedNestedWait`, which `useTreeLookup` masks with
   * the tree's statuses). Here too the tree's statuses win once the page has the branch in it:
   * the tree is read again on every `subagent_*` event, so it is never older than the wait.
   */
  const deepWaits = new Map<string, Set<string>>();
  for (const e of input.events) {
    if (e.type === "subagent_dispatched") {
      ids.add(e.payload.subagentId);
      direct.set(e.payload.subagentId, { status: "running", person: false });
    } else if (e.type === "subagent_waiting") {
      const path = e.payload.path ?? [e.payload.subagentId];
      for (const id of path) ids.add(id);
      ids.add(e.payload.subagentId);
      const top = path[0] ?? e.payload.subagentId;
      if (path.length <= 1) direct.set(top, { status: "waiting", person: true });
      else deepWaits.set(top, (deepWaits.get(top) ?? new Set()).add(e.payload.subagentId));
    } else if (e.type === "subagent_finished") {
      direct.set(e.payload.subagentId, { status: e.payload.status, person: false });
      deepWaits.delete(e.payload.subagentId);
    }
  }
  for (const v of input.views ?? []) {
    ids.add(v.id);
    direct.set(v.id, {
      status: v.status,
      person: v.pendingApprovalIds.length + v.pendingQuestionIds.length > 0,
    });
  }
  for (const id of Object.keys(input.progress)) ids.add(id);
  /** The tree's agents below each of the root's children. */
  const below = new Map<string, AgentTreeNode[]>();
  const collect = (n: AgentTreeNode, into: AgentTreeNode[]) => {
    for (const c of n.children) {
      ids.add(c.id);
      into.push(c);
      collect(c, into);
    }
  };
  for (const child of input.tree?.children ?? []) {
    ids.add(child.id);
    if (!direct.has(child.id)) direct.set(child.id, { status: child.status, person: false });
    const nodes: AgentTreeNode[] = [];
    collect(child, nodes);
    below.set(child.id, nodes);
  }
  ids.delete(input.tree?.id ?? "");

  const runs = (s: string) => s === "running" || s === "queued";
  let running = 0;
  let waiting = 0;
  for (const [id, d] of direct) {
    if (!isActiveStatus(d.status)) continue;
    const deep = below.get(id) ?? [];
    const deepRunning = deep.filter((n) => runs(n.status)).length;
    // a deep agent that waits with nothing active below it waits for a person
    const deepPerson = deep.filter(
      (n) => n.status === "waiting" && !n.children.some((c) => isActiveStatus(c.status)),
    ).length;
    const openWaits = deepWaits.get(id)?.size ?? 0;
    // the tree, read again on every `subagent_*` event (a deep wait's too), masks the log's waits
    const deepWaiting = deep.length > 0 ? deepPerson : openWaits;
    if (runs(d.status)) running += 1;
    else if (d.person) waiting += 1;
    // an active child with nothing below it that counts (no tree yet, or a stale one whose deep
    // agents all read as ended): its branch is working, counted once
    else if (deepRunning + deepWaiting === 0) running += 1;
    running += deepRunning;
    waiting += deepWaiting;
  }
  return { count: ids.size, running, waiting };
}

/** The most often stream progress reads the agent tree again (a trailing throttle window). */
export const TREE_PROGRESS_MS = 1500;

/**
 * Reads of the agent tree, one per {@link TREE_PROGRESS_MS}, after a read that shows an agent
 * below the root's children still active, without new progress or events in between (its end
 * reaches no event of the root's log).
 */
export const TREE_TRAILING_READS = 3;

/** Whether an agent below the root's own children is still going (the root has depth 0). */
function deepActive(n: AgentTreeNode, depth = 0): boolean {
  if (depth >= 2 && isActiveStatus(n.status)) return true;
  return n.children.some((c) => deepActive(c, depth + 1));
}

/**
 * The agent tree of a root conversation (agent map spec §9.2), read whenever it is `enabled` (a
 * root conversation's page that has dispatched a sub-agent: the composer's agents chip counts the
 * whole tree, AC3 fix round 1; the server prefetches it for the first paint) and kept closer while
 * the map is `open`. A `subagent_*` event of its log (the tree's shape or a status moved) reads it
 * again at once. Progress steps of any agent (a descendant's progress reaches every ancestor's
 * stream with its own `subagentId`) are coalesced, at most one read per {@link TREE_PROGRESS_MS}
 * at the end of the window: while the map is open every step counts; while it is closed only a
 * step of an agent the cached tree lacks (a new grandchild), once per agent, or of one it shows
 * waiting, once per answer (it moved on) — the chip needs the count and the dot, not each step.
 * Opening the map reads it once more. A read in flight is never cancelled for a new one
 * (`cancelRefetch: false`).
 * An agent below the root's children ends with no event in the root's log, and its last progress
 * may be read before its run's end commits: while the open map's tree shows one still active, one
 * more read follows each read at the end of a window, at most {@link TREE_TRAILING_READS} in a row
 * without new progress or events (no polling once nothing below is active, none while closed).
 */
export function useAgentTree(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
  progress: Readonly<Record<string, { step: number }>>,
  { enabled, open }: { enabled: boolean; open: boolean },
): { root: AgentTreeNode | undefined; failed: boolean } {
  const qc = useQueryClient();
  const dispatched = useMemo(() => dispatchedAny(events), [events]);
  const count = useMemo(() => subagentEventCount(events), [events]);
  // every agent's step: it moves whenever any agent of the tree makes progress
  const steps = useMemo(
    () =>
      Object.entries(progress)
        .map(([id, p]) => `${id}:${p.step}`)
        .join(","),
    [progress],
  );
  const query = agentTreeQuery(orgId, conversationId);
  const active = dispatched && enabled;
  const r = useQuery({
    ...query,
    enabled: active,
    retryOnMount: retryOnMountOf(query.queryKey),
  });
  const key = useRef(query.queryKey);
  key.current = query.queryKey;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    void qc.invalidateQueries({ queryKey: key.current }, { cancelRefetch: false });
  }, [qc]);
  /** Trailing reads since the last progress step or event. */
  const trailing = useRef(0);
  const seenCount = useRef(count);
  useEffect(() => {
    if (!dispatched || seenCount.current === count) return;
    seenCount.current = count;
    trailing.current = 0;
    refresh();
  }, [count, dispatched, refresh]);
  // opening the map reads it once more (closed, progress steps did not)
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current && active) refresh();
    wasOpen.current = open;
  }, [open, active, refresh]);
  const { data, dataUpdatedAt } = r;
  /** What a closed map's steps already asked a read for: `<id>` (missing), `<id>@<answer>`. */
  const asked = useRef(new Set<string>());
  const seenSteps = useRef(steps);
  /** Each agent's step at the last change: a closed map looks only at the agents that moved. */
  const lastStep = useRef<Map<string, number> | null>(null);
  lastStep.current ??= new Map(Object.entries(progress).map(([id, p]) => [id, p.step]));
  useEffect(() => {
    if (!dispatched || seenSteps.current === steps) return;
    seenSteps.current = steps;
    trailing.current = 0;
    const moved: string[] = [];
    for (const [id, p] of Object.entries(progress)) {
      if (lastStep.current?.get(id) !== p.step) moved.push(id);
      lastStep.current?.set(id, p.step);
    }
    if (!open) {
      if (!active || data === undefined) return;
      const nodes = new Map<string, AgentTreeNode>();
      const walk = (n: AgentTreeNode) => {
        nodes.set(n.id, n);
        n.children.forEach(walk);
      };
      walk(data);
      let ask = false;
      for (const id of moved) {
        const n = nodes.get(id);
        const reason =
          n === undefined ? id : n.status === "waiting" ? `${id}@${dataUpdatedAt}` : null;
        if (reason === null || asked.current.has(reason)) continue;
        asked.current.add(reason);
        ask = true;
      }
      if (!ask) return;
    }
    // the window's first step starts it; later ones ride along
    if (timer.current === null) timer.current = setTimeout(refresh, TREE_PROGRESS_MS);
  }, [steps, dispatched, open, active, data, dataUpdatedAt, progress, refresh]);
  // every answer (also an equal one: `dataUpdatedAt` moves) of the open map
  useEffect(() => {
    if (!open || dataUpdatedAt === 0 || data === undefined || !deepActive(data)) return;
    if (timer.current !== null || trailing.current >= TREE_TRAILING_READS) return;
    trailing.current += 1;
    timer.current = setTimeout(refresh, TREE_PROGRESS_MS);
  }, [open, data, dataUpdatedAt, refresh]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return { root: r.data, failed: r.data === undefined && r.error !== null };
}

/**
 * The conversation's tokens with its sub-agents' (`GET …/usage`), read only once a sub-agent was
 * dispatched and again when one finishes (its usage is final then). Undefined otherwise.
 */
export function useUsageWithSubagents(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
): ConversationUsage | undefined {
  const dispatched = useMemo(() => dispatchedAny(events), [events]);
  const ends = useMemo(() => events.filter((e) => e.type === "subagent_finished").length, [events]);
  const query = usageQuery(orgId, conversationId);
  const usage = useQuery({
    ...query,
    enabled: dispatched,
    retryOnMount: retryOnMountOf(query.queryKey),
  }).data;
  useInvalidateOn(query.queryKey, ends, dispatched);
  return dispatched ? usage : undefined;
}

export const usageTotal = (u: ConversationUsage) =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** A tool of a sub-agent's frozen definition as the task line names it. */
export const subagentToolName = (r: SubagentToolRef): string =>
  r.kind === "connector"
    ? r.connectorId
    : toolLabelText(
        toolLabelOfKey(r.kind === "builtin" ? r.name : extensionToolKey(r.plugin, r.name)),
      );

/** The tools of the task line: up to three names, then "+N". */
export function toolsLine(tools: readonly SubagentToolRef[] | undefined, none: string): string {
  const names = (tools ?? []).map(subagentToolName);
  if (names.length === 0) return none;
  return names.length <= 3
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}
