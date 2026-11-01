"use client";

import { useCallback, useState } from "react";

/**
 * State seeded from a server prop: `set` changes it locally (after a mutation), and it resets to
 * `initial` whenever the server sends a new one (`router.refresh()`, a navigation), compared by
 * reference.
 */
export function useServerState<T>(initial: T): [T, (v: T) => void] {
  const [stored, setStored] = useState<{ source: T; value: T }>({
    source: initial,
    value: initial,
  });
  const set = useCallback((value: T) => setStored({ source: initial, value }), [initial]);
  return [stored.source === initial ? stored.value : initial, set];
}
