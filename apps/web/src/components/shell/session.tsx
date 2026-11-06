"use client";

import { createContext, useContext } from "react";
import type { Me } from "../../lib/session";

/**
 * The signed-in session: `GET /api/v1/me` as the `(app)` layout read it on the server, and the
 * actions that change it. Provided by the layout's AppFrame.
 */
export type Session = {
  me: Me;
  /**
   * Reads the session again: starts a server re-render of the route (`router.refresh()`) and
   * resolves at once, before the new props arrive. Callers must not rely on awaiting it.
   */
  reload(): Promise<void>;
  /**
   * Makes `orgId` the current org (`null` clears it), tells the other tabs, then opens home (the
   * new conversation, `/chat`) with a full navigation (ruling R4): the current page stays until
   * the new document arrives. Rejects when the kernel refuses (nothing navigates then).
   */
  switchOrg(orgId: string | null): Promise<void>;
  /** An org change is waiting for the new document (the page is about to unload). */
  switching?: boolean;
  /** Reads the sidebar's pending count again now (after handling an approval). */
  refreshPending?(): void;
  /** The web version (pages that draw their own status bar show it). */
  version?: string;
  /** The viewer's time zone (`UTC+8`; none in the server render), for those status bars too. */
  timeZone?: string;
};

/** `null` only outside the `(app)` layout (the layout always provides the session). */
export const SessionContext = createContext<Session | null>(null);

/** The session; only inside the `(app)` layout. */
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (s === null) throw new Error("useSession() must be used inside the (app) layout's AppFrame");
  return s;
}
