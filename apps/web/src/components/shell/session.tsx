"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { Me } from "../../lib/session";

/**
 * The signed-in session: `GET /api/v1/me` as the `(app)` layout read it on the server, and the
 * actions that change it. Provided by the layout's AppFrame.
 */
export type Session = {
  me: Me;
  /** Reads the session again: re-renders the route on the server (`router.refresh()`). */
  reload(): Promise<void>;
  /**
   * Makes `orgId` the current org (`null` clears it), then opens its home in a transition: the
   * current page stays until the new org's frame is ready. Rejects when the kernel refuses.
   */
  switchOrg(orgId: string | null): Promise<void>;
  /** An org switch (or another session change) is waiting for the server's new frame. */
  switching?: boolean;
  /** Reads the sidebar's pending count again now (after handling an approval). */
  refreshPending?(): void;
  /** The web version (pages that draw their own status bar show it). */
  version?: string;
};

/** `null` only outside the `(app)` layout (the layout always provides the session). */
export const SessionContext = createContext<Session | null>(null);

/** The session; only inside the `(app)` layout. */
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (s === null) throw new Error("useSession() must be used inside the (app) layout's AppFrame");
  return s;
}

/**
 * Kept for the pages not moved to server rendering yet: the `(app)` layout renders the session on
 * the server, so there is nothing to wait for.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  return children;
}
