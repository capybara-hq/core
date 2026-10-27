"use client";

import { useEffect, useRef, useState } from "react";
import { getToolInfo, type ToolInfo } from "./conversations";

/** The most keys one `GET …/tools?keys=` takes (kernel `TOOL_INFO_MAX_KEYS`). */
const BATCH = 100;

/**
 * Display metadata of the tools a conversation's calls name (`GET …/conversations/:id/tools`):
 * fetched in batches, kept in memory per conversation, and fetched again only for keys not seen
 * yet. A failed fetch leaves those rows on their keys (the timeline's fallback).
 */
export function useToolInfo(
  orgId: string,
  conversationId: string | null,
  keys: readonly string[],
): ReadonlyMap<string, ToolInfo> {
  const [info, setInfo] = useState<{ scope: string; map: ReadonlyMap<string, ToolInfo> }>({
    scope: "",
    map: new Map(),
  });
  const asked = useRef<{ scope: string; keys: Set<string> }>({ scope: "", keys: new Set() });
  const scope = `${orgId}/${conversationId ?? ""}`;
  const keyList = keys.join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keys are represented by keyList
  useEffect(() => {
    if (conversationId === null) return;
    if (asked.current.scope !== scope) asked.current = { scope, keys: new Set() };
    const missing = keys.filter((k) => !asked.current.keys.has(k));
    if (missing.length === 0) return;
    for (const k of missing) asked.current.keys.add(k);
    for (let i = 0; i < missing.length; i += BATCH) {
      getToolInfo(orgId, conversationId, missing.slice(i, i + BATCH)).then(
        ({ tools }) => {
          if (asked.current.scope !== scope) return;
          setInfo((prev) => {
            const map = new Map(prev.scope === scope ? prev.map : []);
            for (const t of tools) map.set(t.key, t);
            return { scope, map };
          });
        },
        () => {
          // Ask again next time (a reload or a new key): rows keep their keys meanwhile.
          for (const k of missing) asked.current.keys.delete(k);
        },
      );
    }
  }, [orgId, conversationId, scope, keyList]);

  return info.scope === scope ? info.map : EMPTY;
}

const EMPTY: ReadonlyMap<string, ToolInfo> = new Map();
