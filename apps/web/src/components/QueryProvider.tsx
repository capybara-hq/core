"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { browserQueryClient } from "../lib/query/client";

/** Provides the browser's query client to the app. */
export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={browserQueryClient()}>{children}</QueryClientProvider>;
}
