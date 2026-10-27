"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ConversationEvent,
  type ConversationUsage,
  getConversationUsage,
  listSubagents,
  type SubagentToolRef,
  type SubagentView,
} from "./conversations";

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

const dispatchedAny = (events: readonly ConversationEvent[]) =>
  events.some((e) => e.type === "subagent_dispatched");

/**
 * The conversation's sub-agents, newest first, read once a sub-agent was dispatched and again on
 * every `subagent_*` event, after a reconnect (`reconnect`), and when stream progress arrives for a
 * child the list shows as waiting or queued (it moved on: someone decided, or it got a slot).
 * `onLoad` gets each read (progress seeds). Undefined before the first read or without sub-agents.
 */
export function useSubagents(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
  progress: Readonly<Record<string, { step: number }>>,
  reconnect: number,
  onLoad?: (views: SubagentView[]) => void,
): { views: SubagentView[] | undefined; refresh(): void } {
  const [views, setViews] = useState<SubagentView[]>();
  const [bump, setBump] = useState(0);
  const dispatched = dispatchedAny(events);
  const count = subagentEventCount(events);
  const load = useRef(onLoad);
  load.current = onLoad;
  // biome-ignore lint/correctness/useExhaustiveDependencies: count, reconnect and bump trigger a reread
  useEffect(() => {
    if (!dispatched) return;
    let live = true;
    listSubagents(orgId, conversationId).then(
      (r) => {
        if (!live) return;
        setViews(r.subagents);
        load.current?.(r.subagents);
      },
      () => {
        // Unreadable: rows keep what the log says.
      },
    );
    return () => {
      live = false;
    };
  }, [orgId, conversationId, dispatched, count, reconnect, bump]);
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
    if (stale !== "") setBump((n) => n + 1);
  }, [stale]);
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  return { views: dispatched ? views : undefined, refresh };
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
  const dispatched = dispatchedAny(events);
  const ends = events.filter((e) => e.type === "subagent_finished").length;
  const [usage, setUsage] = useState<ConversationUsage>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: ends triggers a reread
  useEffect(() => {
    if (!dispatched) return;
    let live = true;
    getConversationUsage(orgId, conversationId).then(
      (r) => {
        if (live) setUsage(r.usage);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [orgId, conversationId, dispatched, ends]);
  return dispatched ? usage : undefined;
}

export const usageTotal = (u: ConversationUsage) =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** A tool of a sub-agent's frozen definition as the task line names it. */
export const subagentToolName = (r: SubagentToolRef): string =>
  r.kind === "builtin" ? r.name : r.kind === "plugin" ? `${r.plugin}__${r.name}` : r.connectorId;

/** The tools of the task line: up to three names, then "+N". */
export function toolsLine(tools: readonly SubagentToolRef[] | undefined, none: string): string {
  const names = (tools ?? []).map(subagentToolName);
  if (names.length === 0) return none;
  return names.length <= 3
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}
