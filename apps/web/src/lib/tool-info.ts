"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ToolInfo } from "./conversations";
import { retryOnMountOf } from "./query/client";
import { toolInfoQuery } from "./query/conversation";

/**
 * Display metadata of the tools a conversation's calls name (`GET …/conversations/:id/tools`),
 * through the query cache: one read per set of keys (in batches). While a new key's read is on its
 * way the previous answer stays; a failed read leaves the rows on their keys (the timeline's
 * fallback), and one the server failed is not read again on mount (R5).
 */
export function useToolInfo(
  orgId: string,
  conversationId: string,
  keys: readonly string[],
): ReadonlyMap<string, ToolInfo> {
  const q = toolInfoQuery(orgId, conversationId, keys);
  const { data } = useQuery({
    ...q,
    enabled: keys.length > 0,
    retryOnMount: retryOnMountOf(q.queryKey),
    placeholderData: keepPreviousData,
  });
  return useMemo(() => (data ? new Map(data.map((t) => [t.key, t])) : EMPTY), [data]);
}

const EMPTY: ReadonlyMap<string, ToolInfo> = new Map();
