"use client";

import * as React from "react";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The Shell environment adapter (mobile layout spec §9.2–§9.4): the one place in apps/web that
 * reads `window.capybaraShell`, the global a native shell (the desktop client, the mobile app)
 * injects into the deployment's top frame (`web-shell-access` rejects reads anywhere else). A page
 * asks for a capability by its `name@major` key (`device@1`) and gets its object, or `undefined`,
 * which means the browser: the page then behaves exactly as in a browser. Never a user agent or
 * `kind` check.
 *
 * The global is untrusted input: only the top frame reads it, only envelope version 1, only own
 * keys of `capabilities` whose value is an object. Two accessors:
 * - {@link useShellCapability} for rendering (is the capability there, its status), reactive: a
 *   shell may add or remove a capability after load (`change`).
 * - {@link shellCapability} for calling one from an event handler, synchronously, in the handler
 *   itself: it throws during a render and outside an event, so a page never raises a confirming
 *   call on its own (the shell refuses one without a user activation, or while another dialog is
 *   open, `busy`; the web never tries).
 */

const KEY = /^[A-Za-z][A-Za-z0-9-]*@[1-9][0-9]*$/;

interface ShellGlobal {
  version: unknown;
  capabilities: unknown;
  on(event: "change", listener: () => void): unknown;
}

/** The global, in the top frame with envelope version 1 and an `on` function; else undefined. */
function shell(): ShellGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    if (window !== window.top) return undefined;
    const s: unknown = (window as Window & { capybaraShell?: unknown }).capybaraShell;
    if (s === null || typeof s !== "object") return undefined;
    const g = s as ShellGlobal;
    return g.version === 1 && typeof g.on === "function" ? g : undefined;
  } catch {
    return undefined;
  }
}

function assertKey(key: string): void {
  if (!KEY.test(key)) {
    throw new TypeError(`shell capability keys are name@major (device@1), got "${key}"`);
  }
}

/** The capability's object under `key`, or undefined (absent, not an object, inherited). */
function read<T extends object>(key: string): T | undefined {
  const s = shell();
  if (s === undefined) return undefined;
  try {
    const caps = s.capabilities;
    if (caps === null || typeof caps !== "object" || !Object.hasOwn(caps, key)) return undefined;
    const cap = (caps as Record<string, unknown>)[key];
    return cap !== null && typeof cap === "object" ? (cap as T) : undefined;
  } catch {
    return undefined;
  }
}

function subscribe(listener: () => void): () => void {
  const s = shell();
  if (s === undefined) return () => {};
  try {
    const off = s.on("change", listener);
    return () => {
      try {
        if (typeof off === "function") off();
      } catch {
        // the shell already dropped it
      }
    };
  } catch {
    return () => {};
  }
}

const serverSnapshot = () => undefined;

/**
 * The capability under `key` (`name@major`) for rendering: `undefined` on the server, during
 * hydration and whenever the shell does not offer it (the browser). Follows the shell's `change`
 * (subscribed through `useSyncExternalStore`, unsubscribed on unmount), so a capability added
 * after load shows up; a page never caches a one-time read. Do not call a confirming function of
 * it from an effect: calls go through {@link shellCapability} in an event handler.
 */
export function useShellCapability<T extends object>(key: string): T | undefined {
  assertKey(key);
  const snapshot = useCallback(() => read<T>(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

type Dispatcher = Record<string, unknown> | null | undefined;
const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H?: Dispatcher };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/**
 * Whether a component is rendering now. React exposes no public test, so this reads its current
 * hooks dispatcher: set while a component renders; null or the context-only dispatcher (every
 * hook the same throwing function) otherwise. Without those internals it answers false and the
 * event check below still holds.
 */
function rendering(): boolean {
  const h = internals?.H;
  return h !== null && h !== undefined && h.useState !== h.useReducer;
}

/**
 * The capability under `key` (`name@major`) for a call from an event handler, or undefined (the
 * browser). Call it synchronously in the handler (`onClick={() => shellCapability(...)?.connect()}`)
 * and keep the object for what follows an await. It throws when called during a render (even one
 * that runs inside an event's dispatch) or outside any event (an effect, a timer), so a page can
 * never raise a confirming native dialog by itself (spec §9.4, plan Review Focus 4).
 */
export function shellCapability<T extends object>(key: string): T | undefined {
  assertKey(key);
  if (rendering() || typeof window === "undefined" || window.event === undefined) {
    throw new Error("calls a shell capability outside an event handler");
  }
  return read<T>(key);
}
