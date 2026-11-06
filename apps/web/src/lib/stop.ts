"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationEvent } from "./conversations";

/**
 * How long a stop may stay under way without the run's end reaching the log: then the page reads
 * the log (and what else the caller names) once more and lets Stop be pressed again (the kernel's
 * abort is idempotent). AC5 fix round 1.
 */
export const STOP_FALLBACK_MS = 15_000;

/** How many runs of a log have ended (their terminal events). */
export const runEnds = (events: readonly ConversationEvent[]): number =>
  events.filter(
    (e) => e.type === "run_finished" || e.type === "run_failed" || e.type === "run_aborted",
  ).length;

/**
 * A stop under way (agent map §6.16.28 `stopping`, the composer's stop): `begin()` at the click; it
 * ends when the log gains a run's end after the click (so an end followed at once by a restart
 * does not carry it into the new run), when the caller calls `release()` (the request failed),
 * or after {@link STOP_FALLBACK_MS}, once `fallback` (a merged re-read) has settled. `scope` is the
 * conversation: a stop never carries over to another one (every caller is keyed per conversation
 * today; this holds without the key too).
 */
export function useStopUnderWay(
  scope: string,
  events: readonly ConversationEvent[],
  fallback: () => Promise<unknown>,
): { requested: boolean; begin(): void; release(): void } {
  const ends = useMemo(() => runEnds(events), [events]);
  /** The run ends the log held at the click; null while no stop is under way. */
  const [endsAtClick, setEndsAtClick] = useState<number | null>(null);
  const [stopScope, setStopScope] = useState(scope);
  if (stopScope !== scope) {
    // another conversation: its stop state starts empty (adjusted while rendering, no effect)
    setStopScope(scope);
    setEndsAtClick(null);
  }
  const endsNow = useRef(ends);
  endsNow.current = ends;
  useEffect(() => {
    if (endsAtClick !== null && ends > endsAtClick) setEndsAtClick(null);
  }, [ends, endsAtClick]);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    if (endsAtClick === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void fallbackRef
        .current()
        .catch(() => undefined)
        .finally(() => {
          if (live) setEndsAtClick(null);
        });
    }, STOP_FALLBACK_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [endsAtClick]);
  const begin = useCallback(() => setEndsAtClick(endsNow.current), []);
  const release = useCallback(() => setEndsAtClick(null), []);
  return { requested: endsAtClick !== null, begin, release };
}
