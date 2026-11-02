"use client";

import { useCallback, useState } from "react";

/**
 * State seeded from a server prop: `set` changes it locally (after a mutation), and it resets to
 * `initial` whenever the server sends a new one (`router.refresh()`, a navigation), compared by
 * reference. `set` also takes an updater, applied to the latest value (several saves finishing in
 * one tick each apply their own change).
 */
export function useServerState<T>(initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [stored, setStored] = useState<{ source: T; value: T }>({
    source: initial,
    value: initial,
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setStored((s) => {
        const prev = s.source === initial ? s.value : initial;
        return {
          source: initial,
          value: typeof v === "function" ? (v as (prev: T) => T)(prev) : v,
        };
      }),
    [initial],
  );
  return [stored.source === initial ? stored.value : initial, set];
}
