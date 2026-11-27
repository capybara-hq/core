"use client";

import { useMemo } from "react";
import { useOpenExternalCapability } from "./shell";

/**
 * A shell's browser handoff (spec 2026-11-28-shell-external-authorization-design.md): in a native
 * shell, connector OAuth and login linking finish in the system browser. The start routes answer
 * a single-use `handoffUrl` instead of the provider's address; the web opens it through
 * `openExternal@1` and waits in the external authorization dialog.
 */

/** The request body's `handoff` part: the shell's own scheme, when it names one. */
export interface HandoffRequest {
  returnScheme?: string;
}

/** The browser handoff a shell offers, or undefined in a browser. */
export interface BrowserHandoff {
  /** The shell's own URL scheme (the done page links back through `<scheme>://open?url=`). */
  returnScheme?: string;
  /** Opens a URL in the system browser. Call it only from event-driven code (a click's work). */
  openExternal(url: string): Promise<void>;
}

/** The body part a start sends with a handoff. */
export const handoffRequest = (h: BrowserHandoff): HandoffRequest =>
  h.returnScheme === undefined ? {} : { returnScheme: h.returnScheme };

/**
 * The browser handoff of the shell the page runs in: defined exactly while the shell offers
 * `openExternal@1` (detected only through `window.capybaraShell`). Keeps its reference while the
 * capability object does.
 */
export function useBrowserHandoff(): BrowserHandoff | undefined {
  const cap = useOpenExternalCapability();
  return useMemo(() => {
    if (cap === undefined || typeof cap.open !== "function") return undefined;
    const scheme = typeof cap.returnScheme === "string" ? cap.returnScheme : undefined;
    return {
      ...(scheme === undefined ? {} : { returnScheme: scheme }),
      openExternal: (url: string) => cap.open(url),
    };
  }, [cap]);
}

/** Only http(s) addresses are opened or navigated to (never `javascript:` and the like). */
export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
}
