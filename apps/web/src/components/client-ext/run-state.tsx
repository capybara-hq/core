"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

/** The open conversation's run as the shell publishes it (`run=` of `data-cap-state`, spec §7.3). */
export type RunState = "idle" | "running" | "waiting" | "failed";

interface Published {
  state: RunState;
  conversationId: string | null;
}

const IDLE: Published = { state: "idle", conversationId: null };

const ValueContext = createContext<Published>(IDLE);
const SetContext = createContext<(p: Published) => void>(() => {});

/** Holds the run state the conversation page publishes; the frame reads it for the shell. */
export function RunStateProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Published>(IDLE);
  return (
    <SetContext.Provider value={setValue}>
      <ValueContext.Provider value={value}>{children}</ValueContext.Provider>
    </SetContext.Provider>
  );
}

/** The published run state: `idle` on every page but an open conversation. */
export function useRunStateValue(): Published {
  return useContext(ValueContext);
}

/** Publishes the open conversation's run state while the page is mounted; leaving writes `idle`. */
export function usePublishRunState(conversationId: string, state: RunState): void {
  const set = useContext(SetContext);
  const next = useMemo(() => ({ state, conversationId }), [state, conversationId]);
  useEffect(() => {
    set(next);
  }, [set, next]);
  // A switch to another conversation publishes its own state above; only leaving writes idle.
  useEffect(() => () => set(IDLE), [set]);
}
