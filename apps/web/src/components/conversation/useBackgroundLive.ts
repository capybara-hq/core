import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { BackgroundTaskView, ConversationEvent } from "../../lib/conversations";
import { retryOnMountOf } from "../../lib/query/client";
import { backgroundTasksQuery, hasBackgroundTasks } from "../../lib/query/conversation";
import type { BackgroundTaskLive } from "../../lib/timeline";

/** The background tasks list by task id, as the timeline reads it ({@link BackgroundTaskLive}). */
export function backgroundLiveOf(
  tasks: readonly BackgroundTaskView[] | undefined,
): ReadonlyMap<string, BackgroundTaskLive> | undefined {
  if (tasks === undefined) return undefined;
  return new Map(
    tasks.map((t) => [
      t.id,
      { status: t.status, starting: t.starting, exitCode: t.exitCode, lostReason: t.lostReason },
    ]),
  );
}

/**
 * The conversation's background tasks for the timeline (a launch row shown as reconciling settles
 * when the list confirms or ends its task). The same query the background section reads, read only
 * once the log names a background task; `changed: background` reads it again.
 */
export function useBackgroundLive(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
): ReadonlyMap<string, BackgroundTaskLive> | undefined {
  const enabled = useMemo(() => hasBackgroundTasks(events), [events]);
  const q = backgroundTasksQuery(orgId, conversationId);
  const r = useQuery({ ...q, enabled, retryOnMount: retryOnMountOf(q.queryKey) });
  return useMemo(() => backgroundLiveOf(r.data), [r.data]);
}
