"use client";

import type { NativeHandlers, NativeNavHandle } from "@capybara-hq/design";
import * as React from "react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

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

/** `PushPlatform` of the SDK's `push.ts` (not part of the mirrored slice below). */
type PushPlatform = "ios" | "android";

/**
 * The desktop shell's capability shapes: a mirror of `packages/plugin-sdk/src/shell-capabilities.ts`
 * (`@capybara-hq/plugin-sdk`; apps/web depends only on the design system and may not import it),
 * keep in step. Capability keys are `name@major`; a rejected call carries `{ code: ShellCallError }`.
 */
export const SHELL_CAPABILITY_KEYS = {
  chrome: "chrome@1",
  device: "device@1",
  notify: "notify@1",
  openExternal: "openExternal@1",
  signIn: "signIn@1",
  haptics: "haptics@1",
  share: "share@1",
  menu: "menu@1",
  nav: "nav@1",
  profiles: "profiles@1",
  push: "push@1",
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

/**
 * A change to this machine's owner ceiling, as `capybara-device ceiling set` takes it
 * (`--outside-sandbox on|off`, `--network open|allowlist`, `--project-reach workspace|os-user`):
 * only the fields to change. A field left out is never touched, so a stale value on the page can
 * never narrow it. A widening needs the shell's native confirmation; a narrowing applies at once.
 */
export interface DeviceCeilingRequest {
  outsideSandbox?: boolean;
  network?: "open" | "allowlist";
  projectReach?: "workspace" | "os-user";
}

/** `device@1`: connect this machine to the deployment as a device. */
export interface DeviceCapabilityV1 {
  status(): Promise<ThisMachineStatus>;
  onStatus(listener: (s: ThisMachineStatus) => void): () => void;
  running(): Promise<RunningOperationView[]>;
  connect(input: { orgId: string; deviceId?: string }): Promise<"connected" | "cancelled">;
  pause(): Promise<void>;
  resume(): Promise<"resumed" | "cancelled">;
  disconnect(): Promise<void>;
  requestCeiling(input: DeviceCeilingRequest): Promise<"applied" | "cancelled">;
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

/**
 * The page's main color tokens (the computed `--cb-bg`, `--cb-panel`, `--cb-ink`, `--cb-muted`,
 * `--cb-line`, `--cb-accent`, `--cb-on-accent`), each a CSS hex or `rgb()` / `rgba()` color. The
 * shell validates them and uses them only as custom properties of its own pages, never as markup.
 */
export interface ShellChromeTokens {
  bg: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  onAccent: string;
}

/**
 * `chrome@1` (mobile layout spec §9.2): the native chrome (window background, title bar, the
 * shell's own pages) follows the page's theme. `tokens` is sent only when all seven are colors;
 * `singleScheme` is true under a UI theme with one scheme (no light / dark toggle on either side).
 */
export interface ChromeCapabilityV1 {
  setAppearance(input: {
    scheme: "light" | "dark";
    background: string;
    tokens?: ShellChromeTokens;
    singleScheme?: boolean;
  }): Promise<void>;
  /** The web's first paint is done (mobile app spec §5.2); a shell may leave it out. */
  ready?(): Promise<void>;
}

export type HapticKind = "selection" | "light" | "success" | "warning";

/** `haptics@1`: a haptic impact (mobile app spec §5.2). */
export interface HapticsCapabilityV1 {
  impact(kind: HapticKind): Promise<void>;
}

export interface ShareInputV1 {
  title?: string;
  text?: string;
  url?: string;
}

/** `share@1`: the system share sheet; resolves whether shared or dismissed. */
export interface ShareCapabilityV1 {
  share(input: ShareInputV1): Promise<void>;
}

export interface MenuItemV1 {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export interface MenuInputV1 {
  title?: string;
  items: MenuItemV1[];
  /** A rect in CSS px from the web view's top-left corner. */
  anchor?: { x: number; y: number; width: number; height: number };
}

/** `menu@1`: a native menu; resolves the chosen item id, or null when dismissed. */
export interface MenuCapabilityV1 {
  show(input: MenuInputV1): Promise<string | null>;
}

/** The shell validates every input against these (and the web keeps within them). */
export const MOBILE_SHELL_LIMITS = {
  menuItems: 12,
  menuLabel: 64,
  menuTitle: 128,
  shareTitle: 256,
  shareText: 4000,
  url: 2048,
  /** `nav@1`: a section or menu label is 1..32 characters. */
  navLabel: 32,
  /** `nav@1`: a badge count is an integer 0..9999 (`countMore` says there are more). */
  navCount: 9999,
  /** `nav@1`: the account's name is 1..64 characters (its initial 1..2). */
  navAccountName: 64,
} as const;

/** The menu item id pattern, checked on `menu@1.show` (the shell validates every input). */
export const MENU_ITEM_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The strip's items: the four sections and, last, `search` (opens the web's command palette; never
 * `current`). A shell before the 2026-11-22 minor version knows only the four sections.
 */
export type NavSectionId = "chats" | "inbox" | "agents" | "schedules" | "search";

/** The strip's items in display order. */
export const NAV_SECTION_ORDER: readonly NavSectionId[] = [
  "chats",
  "inbox",
  "agents",
  "schedules",
  "search",
];

export interface NavBadgeV1 {
  count?: number;
  countMore?: boolean;
}

export interface NavItemV1 extends NavBadgeV1 {
  id: NavSectionId;
  label: string;
}

export interface NavMenuV1 extends NavBadgeV1 {
  label: string;
}

/**
 * The pill's top item, accent-filled: the page's primary action, else the new conversation
 * (`id` matches MENU_ITEM_ID, `label` 1..navLabel; the shell draws its own glyph per `icon`).
 */
export interface NavActionV1 {
  id: string;
  label: string;
  icon: "plus" | "square-pen";
}

/**
 * The account avatar under the strip's status: the image at `avatarUrl` (an absolute https URL
 * or one on the profile's origin), else `initial` in a circle; `badge` a count 0..navCount.
 */
export interface NavAccountV1 {
  name: string;
  avatarUrl?: string | null;
  initial: string;
  badge?: number;
}

export interface NavStateV1 {
  /** The items the person sees, in NAV_SECTION_ORDER (a guest has no `schedules`). */
  items: NavItemV1[];
  current: NavSectionId | null;
  /**
   * The strip's menu button, or null for none. Optional in the type since the 2026-11-22 minor
   * version, but the current web always sends `null` (no menu button on the strip, D12); an older
   * web may send a button.
   */
  menu?: NavMenuV1 | null;
  /** The pill's top item (absent: the shell shows none). */
  action?: NavActionV1;
  /** The avatar under the status (absent: the shell shows none). */
  account?: NavAccountV1;
}

/**
 * `nav@1`: offered only while the window has a strip (mobile app spec §6.1): presence is
 * visibility. `side` is the edge the strip is on (right unless the app is the left one of a
 * split), reported with the capability and updated with the envelope's `change`. `onAction`,
 * `onAccount` and `side` arrived in a minor version: a shell before it lacks them and its `set`
 * validator rejects any key beyond `items` / `current` / `menu`, an absent `menu`, more than the
 * four sections and the `search` item. The web treats a capability without an `onAction`
 * function as such a shell and sends it exactly `{ items: the four sections, current, menu: null }`.
 */
export interface NavCapabilityV1 {
  set(state: NavStateV1): Promise<void>;
  onSelect(listener: (id: NavSectionId) => void): () => void;
  onMenu(listener: () => void): () => void;
  /** The pill's top item was tapped: the web runs the action. */
  onAction?(listener: () => void): () => void;
  /** The account avatar was tapped: the web opens its account sheet. */
  onAccount?(listener: () => void): () => void;
  readonly side?: "left" | "right";
}

/** `profiles@1`: the native profile switcher. */
export interface ProfilesCapabilityV1 {
  /** Opens the native profile switcher; resolves when it closes, with nothing. */
  show(): Promise<void>;
}

export type PushPermission = "granted" | "denied" | "prompt";

export interface PushStatus {
  permission: PushPermission;
  /** The server-side registration id this install holds, or null. */
  registrationId: string | null;
  /** The OS token differs from the one last registered. */
  tokenChanged: boolean;
}

/** What the shell hands the web app to register with the deployment. */
export interface PushRegistration {
  platform: PushPlatform;
  appId: string;
  provider: string;
  token: string;
}

/** `push@1`: native push registration (mobile shells). */
export interface PushCapabilityV1 {
  status(): Promise<PushStatus>;
  /** User activation only when permission is "prompt"; rejects { code: "cancelled" } when denied. */
  register(): Promise<PushRegistration>;
  /** Tells the shell the deployment's registration id for this install. */
  registered(id: string): Promise<void>;
  unregister(): Promise<void>;
}

export const useDeviceCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.device) as DeviceCapabilityV1 | undefined;
export const useNotifyCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.notify) as NotifyCapabilityV1 | undefined;
export const useSignInCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.signIn) as SignInCapabilityV1 | undefined;
export const useHapticsCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.haptics) as HapticsCapabilityV1 | undefined;
export const useShareCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.share) as ShareCapabilityV1 | undefined;
export const useMenuCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.menu) as MenuCapabilityV1 | undefined;
export const useNavCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.nav) as NavCapabilityV1 | undefined;
export const useProfilesCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.profiles) as ProfilesCapabilityV1 | undefined;
export const useOpenExternalCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.openExternal) as OpenExternalCapabilityV1 | undefined;

/**
 * The native strip as the design takes it (`nav@1` adapted; mobile app spec §6.1, interaction
 * model §10.2–10.3): present exactly while the shell has a strip. `set` is a state push, not
 * confirming (the shell needs no activation), and the one capability call made from an effect: a
 * rejection or a throw is dropped (the strip keeps its last state). `onAction` / `onAccount` pass
 * through when the shell has them (a shell before the minor version lacks them); the web never
 * subscribes to `onMenu` (it sends no menu, D12). The strip's side is read by the design's
 * environment, not here. The handle keeps its reference while the capability object does.
 */
export function useNativeNavHandle(): NativeNavHandle | undefined {
  const nav = useNavCapability();
  return useMemo(
    () =>
      nav === undefined
        ? undefined
        : {
            set: (state) => {
              try {
                nav.set(state).catch(() => {});
              } catch {
                // a shell that throws leaves the strip as it was
              }
            },
            onSelect: (listener) => nav.onSelect(listener),
            ...(typeof nav.onAction === "function"
              ? { onAction: (listener: () => void) => nav.onAction?.(listener) ?? (() => {}) }
              : {}),
            ...(typeof nav.onAccount === "function"
              ? { onAccount: (listener: () => void) => nav.onAccount?.(listener) ?? (() => {}) }
              : {}),
          },
    [nav],
  );
}

/**
 * The account sheet's "Switch platform" (`profiles@1.show`, mobile app spec §5.2): undefined without
 * the capability (the browser, an app locked to one deployment). Call it inside the click's
 * handler: the shell's switcher is confirming and needs the user activation. It resolves with
 * nothing whatever is picked; a refusal (`busy`, `no_activation`) is dropped.
 */
export function useSwitchProfile(): (() => void) | undefined {
  const profiles = useProfilesCapability();
  return useMemo(
    () =>
      profiles === undefined
        ? undefined
        : () => {
            try {
              profiles.show().catch(() => {});
            } catch {
              // the switcher did not open
            }
          },
    [profiles],
  );
}

/**
 * The design's native handlers, only for the capabilities the shell has (none in a browser). Each
 * call runs in the design's event handlers (spec §9.4). A haptic is decoration: a rejection is
 * swallowed.
 */
export function useNativeHandlers(): NativeHandlers {
  const haptics = useHapticsCapability();
  const share = useShareCapability();
  const menu = useMenuCapability();
  return useMemo(
    () => ({
      ...(menu === undefined
        ? {}
        : {
            menu: (input) => {
              const { anchor: a, ...rest } = input;
              // the shell takes a whole rect (a DOMRectInit's fields are optional)
              const anchor =
                a?.x === undefined || a.y === undefined
                  ? undefined
                  : { x: a.x, y: a.y, width: a.width ?? 0, height: a.height ?? 0 };
              return menu.show(anchor === undefined ? rest : { ...rest, anchor });
            },
          }),
      ...(share === undefined ? {} : { share: (input) => share.share(input) }),
      ...(haptics === undefined
        ? {}
        : {
            haptics: (kind) => {
              haptics.impact(kind).catch(() => {});
            },
          }),
    }),
    [haptics, share, menu],
  );
}
export const usePushCapability = () =>
  useShellCapability(SHELL_CAPABILITY_KEYS.push) as PushCapabilityV1 | undefined;
