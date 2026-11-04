"use client";

import { useState } from "react";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface SectionDraft<T> {
  /** What the section shows: the edits, or the saved value while nothing was edited. */
  draft: T;
  /** Change the draft: a partial value merged over it, or a function of it. */
  set(next: Partial<T> | ((cur: T) => T)): void;
  /** The draft differs from the saved value. */
  dirty: boolean;
  /** Drop the edits: the section follows the saved value again (after a save, or a discard). */
  reset(): void;
}

/**
 * One section's unsaved edits over its saved value (agent profile design §3.2: each section has
 * its own unsaved state). Until something is edited the draft is the saved value itself, so a save
 * that writes the new value into the cache, followed by `reset()`, shows the saved value.
 */
export function useSectionDraft<T extends object>(saved: T): SectionDraft<T> {
  const [edits, setEdits] = useState<T | undefined>(undefined);
  const draft = edits ?? saved;
  return {
    draft,
    set: (next) =>
      setEdits((cur) => {
        const base = cur ?? saved;
        return typeof next === "function" ? next(base) : { ...base, ...next };
      }),
    dirty: edits !== undefined && !sameJson(edits, saved),
    reset: () => setEdits(undefined),
  };
}
