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
 * - {@link useShellCapability}: the capability's object for rendering and for the calls a page
 *   makes from event-driven code (a click's handler, the mutation function a click starts, which
 *   runs after a microtask). Reactive: a shell may add or remove a capability after load
 *   (`change`); the object keeps its reference until the shell says it changed.
 * - {@link shellCapability}: a one-off read inside an event handler. It throws during a render,
 *   and without a transient user activation (`navigator.userActivation.isActive`; where a browser
 *   lacks that API, without an event being dispatched).
 *
 * The confirming-call rule (spec §9.4) is the shell's: a capability call that needs a native
 * confirmation is refused unless the page has a transient user activation at that moment, and
 * while another native dialog is open (`busy`); the shell's injected code checks
 * `navigator.userActivation` itself. The web's part is never to call a capability during a
 * render or from code no person started (an effect, a timer).
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

/**
 * The snapshots `useShellCapability` renders from, per key, for one shell object. A shell may
 * hand out a fresh `capabilities` object (or fresh capability objects) on every access (a getter,
 * a bridge that copies), so a snapshot is read once and kept until the shell fires `change`;
 * `useSyncExternalStore` then sees the same reference while nothing changed.
 */
let cache: { shell: ShellGlobal; values: Map<string, object | undefined> } | null = null;
/** The components subscribed, and the one `change` subscription held for all of them. */
const listeners = new Set<() => void>();
let unsubscribeShell: (() => void) | null = null;

function cached<T extends object>(key: string): T | undefined {
  const s = shell();
  if (s === undefined) return undefined;
  if (cache === null || cache.shell !== s) cache = { shell: s, values: new Map() };
  if (!cache.values.has(key)) cache.values.set(key, read(key));
  return cache.values.get(key) as T | undefined;
}

function onShellChange(): void {
  cache?.values.clear();
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // the first subscriber keeps what its render read (cleared when the last one left), so the
    // re-check after subscribing sees the same reference
    const s = shell();
    if (s !== undefined) {
      try {
        const off = s.on("change", onShellChange);
        unsubscribeShell = typeof off === "function" ? (off as () => void) : null;
      } catch {
        unsubscribeShell = null;
      }
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    // nobody hears `change` any more: what is cached may go stale
    cache = null;
    const off = unsubscribeShell;
    unsubscribeShell = null;
    try {
      off?.();
    } catch {
      // the shell already dropped it
    }
  };
}

const serverSnapshot = () => undefined;

/**
 * The capability under `key` (`name@major`): `undefined` on the server, during hydration and
 * whenever the shell does not offer it (the browser). Follows the shell's `change` (subscribed
 * through `useSyncExternalStore`, unsubscribed on unmount), so a capability added after load
 * shows up; the object keeps its reference until the shell fires `change`. Call its functions
 * from event-driven code (a handler, the mutation function a click starts), never during a
 * render or from an effect or timer; a confirming call is refused by the shell without a user
 * activation.
 */
export function useShellCapability<T extends object>(key: string): T | undefined {
  assertKey(key);
  const snapshot = useCallback(() => cached<T>(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

type Dispatcher = Record<string, unknown> | null | undefined;
const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H?: Dispatcher };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/**
 * Whether a function component is rendering now. React exposes no public test, so this reads its
 * current hooks dispatcher: set while a function component renders; null or the context-only
 * dispatcher (every hook the same throwing function) otherwise. It does not see a class
 * component's render (no hooks dispatcher then), and without those internals it answers false.
 */
function rendering(): boolean {
  const h = internals?.H;
  return h !== null && h !== undefined && h.useState !== h.useReducer;
}

/**
 * Whether the page has a transient user activation now (`navigator.userActivation.isActive`, the
 * signal the shell itself checks). Where the browser lacks the API, an event being dispatched
 * (`window.event`) stands in: it only says the call comes from an event handler, not that a
 * person started it, and the shell's own check stays the barrier.
 */
function activated(): boolean {
  if (typeof window === "undefined") return false;
  const ua = (navigator as Navigator & { userActivation?: { isActive?: unknown } }).userActivation;
  if (ua !== undefined && ua !== null) return ua.isActive === true;
  return window.event !== undefined;
}

/**
 * The capability under `key` (`name@major`) for a one-off call from an event handler, or
 * undefined (the browser). It throws when called during a render (even one that runs inside an
 * event's dispatch), and without a transient user activation (an effect, a timer), so a page
 * never asks the shell for a confirming call on its own (spec §9.4, plan Review Focus 4). Code
 * that runs later in the same interaction (a mutation function) uses the object of
 * {@link useShellCapability} instead.
 */
export function shellCapability<T extends object>(key: string): T | undefined {
  assertKey(key);
  if (rendering()) throw new Error("calls a shell capability outside an event handler");
  if (!activated()) throw new Error("calls a shell capability without a user activation");
  return read<T>(key);
}

/**
 * The desktop shell's capability shapes: a mirror of `packages/plugin-sdk/src/shell-capabilities.ts`
 * (`@capybara-hq/plugin-sdk`; apps/web depends only on the design system and may not import it),
 * keep in step. Capability keys are `name@major`; a rejected call carries `{ code: ShellCallError }`.
 */
export const SHELL_CAPABILITY_KEYS = {
  device: "device@1",
  notify: "notify@1",
  openExternal: "openExternal@1",
  signIn: "signIn@1",
} as const;

export type KeepAwakeMode = "off" | "while-busy" | "connected";

export type DeviceConnection = "starting" | "online" | "offline" | "draining" | "stopped";

/** What this machine is to the deployment the shell shows. */
export type ThisMachineStatus =
  | { state: "not_connected" }
  | { state: "connected_elsewhere"; origin: string }
  | {
      state: "connected";
      deviceId: string;
      orgId: string;
      mode: "os" | "docker";
      connection: DeviceConnection;
      offlineReason?: string;
      serviceInstalled: boolean;
      keepAwake: { mode: KeepAwakeMode; held: boolean; unavailable?: string };
      lastWakeAt?: string;
    };

/** One operation running on this machine for the deployment. */
export interface RunningOperationView {
  tag: string;
  conversationId: string | null;
  accountId: string | null;
  isolation: "restricted" | "full";
  startedAt: string;
}

/** The `code` of a rejected shell call. */
export type ShellCallError = "busy" | "no_activation" | "cancelled" | "failed";

/** `device@1`: connect this machine to the deployment as a device. */
export interface DeviceCapabilityV1 {
  status(): Promise<ThisMachineStatus>;
  onStatus(listener: (s: ThisMachineStatus) => void): () => void;
  running(): Promise<RunningOperationView[]>;
  connect(input: { orgId: string; deviceId?: string }): Promise<"connected" | "cancelled">;
  pause(): Promise<void>;
  resume(): Promise<"resumed" | "cancelled">;
  disconnect(): Promise<void>;
  requestCeiling(input: {
    fullAccess: boolean;
    projectReach: "workspace" | "os-user";
  }): Promise<"applied" | "cancelled">;
  setKeepAwake(mode: KeepAwakeMode): Promise<"applied" | "cancelled">;
}

/** `notify@1`: a native notification; `path` is the in-app path opened on click. */
export interface NotifyCapabilityV1 {
  notify(input: { title: string; body: string; path?: string }): Promise<void>;
}

/** `openExternal@1`: open a URL in the system browser. */
export interface OpenExternalCapabilityV1 {
  open(url: string): Promise<void>;
}

/** `signIn@1`: sign in through the system browser (desktop client spec §6.5). */
export interface SignInCapabilityV1 {
  start(): Promise<"signedIn" | "cancelled">;
}

export const useDeviceCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.device) as DeviceCapabilityV1 | undefined;
export const useNotifyCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.notify) as NotifyCapabilityV1 | undefined;
export const useSignInCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.signIn) as SignInCapabilityV1 | undefined;
