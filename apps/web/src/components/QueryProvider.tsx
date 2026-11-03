"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { browserQueryClient, noteClientPath } from "../lib/query/client";
import { SessionGuard } from "./SessionGuard";

/**
 * Provides the browser's query client to the app, and tells it the pathname. That happens during
 * render, not in an effect: the new page's observers read `isHydratedError` while they render, so
 * a client navigation must have forgotten the document's errors by then (it only forgets on a path
 * change, so repeated renders and StrictMode's double render are harmless). The session guard
 * signs in again when a read finds the session gone.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  noteClientPath(usePathname());
  return (
    <QueryClientProvider client={browserQueryClient()}>
      <SessionGuard>{children}</SessionGuard>
    </QueryClientProvider>
  );
}
