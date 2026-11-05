"use client";

import { useEffect, useRef } from "react";

/** What changed in the session, as told to the other tabs (web-SSR spec §3.2). */
export type SessionChange = "signed-in" | "signed-out" | "org-switched";

const CHANNEL = "capybara-session";
/** The `storage`-event fallback's key (browsers without BroadcastChannel). */
const STORAGE_KEY = "capybara:session";
/** This tab: a BroadcastChannel instance in the same tab would otherwise hear its own message. */
const TAB = Math.random().toString(36).slice(2);

type Message = { kind: SessionChange; from: string; at: number };

const isMessage = (m: unknown): m is Message =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as Message).from === "string" &&
  ["signed-in", "signed-out", "org-switched"].includes((m as Message).kind);

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

/** Tells the other tabs of this browser that the session changed. */
export function broadcastSession(kind: SessionChange): void {
  const message: Message = { kind, from: TAB, at: Date.now() };
  const channel = openChannel();
  if (channel !== null) {
    try {
      channel.postMessage(message);
    } catch {
      // Nothing else to do: the other tabs notice at their next request.
    } finally {
      channel.close();
    }
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Storage unavailable (private mode, blocked): no cross-tab sync.
  }
}

/**
 * Follows session changes made in other tabs: `onSignedChange` for a sign-in or sign-out (the tab
 * reloads), `onOrgSwitched` for an org switch (the current org belongs to the session the tabs
 * share). Uses BroadcastChannel, else the `storage` event.
 */
export function useSessionSync(onSignedChange: () => void, onOrgSwitched: () => void): void {
  const signed = useRef(onSignedChange);
  signed.current = onSignedChange;
  const org = useRef(onOrgSwitched);
  org.current = onOrgSwitched;
  useEffect(() => {
    const handle = (m: unknown) => {
      if (!isMessage(m) || m.from === TAB) return;
      if (m.kind === "org-switched") org.current();
      else signed.current();
    };
    const channel = openChannel();
    if (channel !== null) {
      channel.onmessage = (e: MessageEvent) => handle(e.data);
      return () => channel.close();
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue === null) return;
      try {
        handle(JSON.parse(e.newValue));
      } catch {
        // Not ours.
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}
