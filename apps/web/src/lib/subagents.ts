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
  const query = subagentsQuery(orgId, conversationId);
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
 * that the last answer still names the agents of the log's older waits.
 */
export function useTreeLookup(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
): TreeLookup | undefined {
  const nested = useMemo(() => hasNestedWait(events), [events]);
  const unresolved = useMemo(() => hasUnresolvedNestedWait(events), [events]);
  const query = agentTreeQuery(orgId, conversationId);
  const root = useQuery({
    ...query,
    enabled: unresolved,
    retryOnMount: retryOnMountOf(query.queryKey),
  }).data;
  return useMemo(() => {
    if (!nested || root === undefined) return undefined;
    const nodes = new Map<string, AgentTreeNode>();
    const walk = (n: AgentTreeNode) => {
      nodes.set(n.id, n);
      n.children.forEach(walk);
    };
    walk(root);
    return {
      agentName: (id) => nodes.get(id)?.description || nodes.get(id)?.agentType || undefined,
      agentStatus: (id) => nodes.get(id)?.status,
    };
  }, [nested, root]);
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
 * The agent tree of a root conversation (agent map spec §9.2), read while the map is `open` and
 * the conversation has dispatched a sub-agent. A `subagent_*` event of its log (the tree's shape
 * or a status moved) reads it again at once; progress steps of any agent (a descendant's progress
 * reaches every ancestor's stream with its own `subagentId`) are coalesced: at most one read per
 * {@link TREE_PROGRESS_MS}, at the end of the window. A read in flight is never cancelled for a
 * new one (`cancelRefetch: false`). Invalidating while the map is closed only marks it stale.
 * An agent below the root's children ends with no event in the root's log, and its last progress
 * may be read before its run's end commits: while the open map's tree shows one still active, one
 * more read follows each read at the end of a window, at most {@link TREE_TRAILING_READS} in a row
 * without new progress or events (no polling once nothing below is active).
 */
export function useAgentTree(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
  progress: Readonly<Record<string, { step: number }>>,
  open: boolean,
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
  const r = useQuery({
    ...query,
    enabled: dispatched && open,
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
  const seenSteps = useRef(steps);
  useEffect(() => {
    if (!dispatched || seenSteps.current === steps) return;
    seenSteps.current = steps;
    trailing.current = 0;
    // the window's first step starts it; later ones ride along
    if (timer.current === null) timer.current = setTimeout(refresh, TREE_PROGRESS_MS);
  }, [steps, dispatched, refresh]);
  // every answer (also an equal one: `dataUpdatedAt` moves) of the open map
  const { data, dataUpdatedAt } = r;
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
