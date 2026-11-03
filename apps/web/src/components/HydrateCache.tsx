"use client";

import { type DehydratedState, HydrationBoundary } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { reviveDehydrated } from "../lib/query/client";

/**
 * Hydrates what a layout read on the server into the browser's cache. The kernel errors are
 * revived here, in the browser, so a server render never records them.
 */
export function HydrateCache({ state, children }: { state: DehydratedState; children: ReactNode }) {
  const revived = useMemo(() => reviveDehydrated(state), [state]);
  return <HydrationBoundary state={revived}>{children}</HydrationBoundary>;
}
