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
function useInvalidateOn(queryKey: readonly unknown[], count: number | string, active: boolean) {
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

/**
 * The agent tree of a root conversation (agent map spec §9.2), read while the map is `open` and
 * the conversation has dispatched a sub-agent, and again on every `subagent_*` event of its log and
 * every progress step of any agent of the tree (a descendant's progress reaches every ancestor's
 * stream with its own `subagentId`). Invalidating while the map is closed only marks it stale.
 */
export function useAgentTree(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
  progress: Readonly<Record<string, { step: number }>>,
  open: boolean,
): { root: AgentTreeNode | undefined; failed: boolean } {
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
  useInvalidateOn(query.queryKey, `${count}/${steps}`, dispatched);
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
