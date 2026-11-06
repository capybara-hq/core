"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type Agent, type ProfileInput, updateAgentProfile } from "../agents";
import { type ApiClientError, clientError } from "../api";
import { keys } from "./keys";

/**
 * A write that invalidates the listed keys (awaited) before the caller's `onSuccess` runs.
 *
 * A hook module for client components only: server layouts import `define.ts` (prefetching through
 * `defineQuery` options), so the hooks live here, never there.
 *
 * `forgetsOnLeave` lists what a successful write made unreadable (my own delete: the detail I
 * leave). Those queries are removed when the calling component unmounts, so Back does not paint the
 * deleted object from the cache. Removing them earlier, while the view still observes them, would
 * read them again and flash the not-found state before the navigation lands.
 */
export function useAppMutation<V, R>(o: {
  fn: (v: V) => Promise<R>;
  invalidates: (v: V, r: R) => (readonly unknown[])[];
  forgetsOnLeave?: (v: V, r: R) => (readonly unknown[])[];
  onSuccess?: (r: R, v: V) => void;
  /**
   * A failure, at the hook level: it runs even after the calling component unmounted (a `mutate`
   * call's own `onError` does not), so a report of the failure is never lost.
   */
  onError?: (e: ApiClientError, v: V) => void;
  /** Mutations sharing a scope id run one after another (TanStack `scope`). */
  scope?: string;
}) {
  const qc = useQueryClient();
  const forgotten = useRef<(readonly unknown[])[]>([]);
  useEffect(
    () => () => {
      for (const queryKey of forgotten.current) qc.removeQueries({ queryKey });
      forgotten.current = [];
    },
    [qc],
  );
  return useMutation<R, ApiClientError, V>({
    mutationFn: o.fn,
    ...(o.scope !== undefined && { scope: { id: o.scope } }),
    onSuccess: async (r, v) => {
      await Promise.all(o.invalidates(v, r).map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (o.forgetsOnLeave) forgotten.current.push(...o.forgetsOnLeave(v, r));
      o.onSuccess?.(r, v);
    },
    ...(o.onError !== undefined && { onError: o.onError }),
  });
}

/**
 * Save an agent's profile. It sends the cached `profile.updatedAt` as `expectedUpdatedAt` (a 409
 * `agent.profile_conflict` reaches the caller as the mutation error) and writes the answer into
 * the agent queries without a refetch: a profile change creates no version and no other field moves.
 */
export function useUpdateProfile(orgId: string, agentId: string) {
  const qc = useQueryClient();
  const agentKey = keys.org(orgId).agent(agentId);
  const listKey = keys.org(orgId).agents();
  return useAppMutation<
    ProfileInput & { expectedUpdatedAt?: string },
    { profile: Agent["profile"] }
  >({
    fn: ({ expectedUpdatedAt, ...input }) => {
      const expected = expectedUpdatedAt ?? qc.getQueryData<Agent>(agentKey)?.profile.updatedAt;
      if (expected === undefined) return Promise.reject(clientError("agent.profile_unloaded"));
      return updateAgentProfile(orgId, agentId, { ...input, expectedUpdatedAt: expected });
    },
    // saves of one agent run one after another: each reads the cached `updatedAt` in `fn`, after
    // the previous save's `onSuccess` set the new one
    scope: `agent-profile-${orgId}-${agentId}`,
    // the answer is the new truth: set it, do not refetch
    invalidates: () => [],
    onSuccess: ({ profile }) => {
      qc.setQueryData<Agent>(agentKey, (a) => (a ? { ...a, profile } : a));
      qc.setQueryData<{ agents: Agent[] }>(listKey, (l) =>
        l ? { agents: l.agents.map((a) => (a.id === agentId ? { ...a, profile } : a)) } : l,
      );
    },
  });
}
