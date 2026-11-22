import { createContext, type KeyboardEvent, useContext, useRef } from "react";
import type { MenuItem } from "./overlays/menus";

/**
 * Native handles (mobile app spec §6): what a native shell offers the page in place of the web's
 * own strip sections, menus, share and haptics. The design package imports nothing from a shell or
 * from the plugin SDK: these shapes restate the SDK's `nav@1` / `menu@1` / `share@1` / `haptics@1`
 * structurally, and apps/web passes the shell's capabilities in (`DesignProvider native`,
 * `AppShell nativeNav`). Without them (the browser) the design draws its own.
 */

/**
 * The native strip's items (`nav@1`), in display order: the four sections and `search`, which
 * opens the command palette (never current).
 */
export type NativeSectionId = "chats" | "inbox" | "agents" | "schedules" | "search";

/** The strip's items in display order (the SDK's `NAV_SECTION_ORDER`). */
export const NATIVE_SECTION_ORDER: readonly NativeSectionId[] = [
  "chats",
  "inbox",
  "agents",
  "schedules",
  "search",
];

/** The bounds the shell validates `nav@1` state against (the SDK's `MOBILE_SHELL_LIMITS`). */
export const NATIVE_NAV_LIMITS = { label: 32, count: 9999 } as const;
/** The account name's bound (the SDK's `MOBILE_SHELL_LIMITS.navAccountName`). */
export const NATIVE_NAV_ACCOUNT_NAME = 64;

/**
 * The strip's whole state (`nav@1.set`, mobile app spec §5.2; interaction model §10.2–10.3): the
 * items the person sees (with the inbox count), the current section, the pill's top item (the
 * page's primary, else the new conversation) and the account avatar. No menu button (D12). The
 * shell takes exactly this shape: it ships in lockstep with the web (no older-shell path).
 */
export interface NativeNavState {
  items: { id: NativeSectionId; label: string; count?: number; countMore?: boolean }[];
  current: NativeSectionId | null;
  action: { id: string; label: string; icon: "plus" | "square-pen" };
  account?: { name: string; avatarUrl?: string | null; initial: string; badge?: number };
}

/**
 * The native strip (`nav@1`, mobile app spec §6.1): the iPhone Duo's strip with the account
 * avatar and the pill, offered only while the window has one (its presence is the strip's
 * visibility). The strip's side is not here: the environment reads it (`data-strip`).
 */
export interface NativeNavHandle {
  /** The strip's whole state. */
  set(state: NativeNavState): void;
  /** A tap on an item, also the current one; returns the unsubscribe. */
  onSelect(listener: (id: NativeSectionId) => void): () => void;
  /** A tap on the pill's top item; returns the unsubscribe. */
  onAction(listener: () => void): () => void;
  /** A tap on the account avatar; returns the unsubscribe. */
  onAccount(listener: () => void): () => void;
}

export type NativeHapticKind = "selection" | "light" | "success" | "warning";

/** The native handlers a shell offers (`menu@1`, `share@1`, `haptics@1`); each one optional. */
export interface NativeHandlers {
  /**
   * The platform's action sheet: resolves the picked item's id, or null when dismissed. A
   * rejection makes the design draw its own menu.
   */
  menu?(input: {
    title?: string;
    items: { id: string; label: string; destructive?: boolean; disabled?: boolean }[];
    anchor?: DOMRectInit;
  }): Promise<string | null>;
  share?(input: { title?: string; text?: string; url?: string }): Promise<void>;
  haptics?(kind: NativeHapticKind): void;
}

export const NativeContext = createContext<NativeHandlers | null>(null);

/** The DesignProvider's native handlers, null in a browser. */
export function useNative(): NativeHandlers | null {
  return useContext(NativeContext);
}

const noHaptics = () => {};

/**
 * Plays a native haptic (`haptics@1`): a no-op without a handler. A handler that throws never
 * breaks the action it accompanies.
 */
export function useHaptics(): (kind: NativeHapticKind) => void {
  const haptics = useContext(NativeContext)?.haptics;
  if (haptics === undefined) return noHaptics;
  return (kind) => {
    try {
      haptics(kind);
    } catch {
      // a haptic is decoration: the action goes on
    }
  };
}

/**
 * Whether a menu can open as the platform's action sheet: it has an item and every item is a
 * plain action (no choice of a set, no submenu, no link). Separators are dropped there.
 */
export function isPlainMenu(items: readonly MenuItem[]): boolean {
  const actions = items.filter((i) => i !== "separator");
  return (
    actions.length > 0 &&
    actions.every(
      (i) =>
        i.checked === undefined &&
        i.submenu === undefined &&
        i.href === undefined &&
        typeof i.onSelect === "function",
    )
  );
}

/** The ids the native menu accepts (`menu@1`); other ids are replaced by the item's position. */
export const NATIVE_MENU_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** One native menu item and the action it stands for. */
export type NativeMenuAction = {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  run(): void;
};

/**
 * The trigger props of a menu that opens as the platform's action sheet (`menu` given): the
 * sheet opens on the click (Radix's own pointerdown is cancelled; a touch pointerdown is no user
 * activation) or on Enter, Space and ↓ (one sheet per Space press: its keyup click is skipped; a
 * press whose keyup never comes is forgotten on blur or the next pointerdown), anchored to the
 * trigger's rect. A pick runs its action (an unknown or disabled id runs nothing), a dismissal
 * nothing, and a throw or rejection calls `fallback` (the design's own menu). One sheet at a time.
 * Without `menu`: no props.
 */
export function useNativeMenuTrigger(
  menu: NativeHandlers["menu"] | undefined,
  build: () => { title?: string | undefined; actions: NativeMenuAction[] },
  fallback: () => void,
): {
  onPointerDown?(e: { preventDefault(): void }): void;
  onBlur?(): void;
  onClick?(e: { currentTarget: HTMLElement }): void;
  onKeyDown?(e: KeyboardEvent<HTMLElement>): void;
  onKeyUp?(e: KeyboardEvent<HTMLElement>): void;
} {
  const showing = useRef(false);
  // Space opened the sheet on keydown: the button's own click on keyup is the same press
  const spacePress = useRef(false);
  if (menu === undefined) return {};
  const show = (el: HTMLElement) => {
    if (showing.current) return;
    showing.current = true;
    const { title, actions } = build();
    const byId = new Map(actions.map((a) => [a.id, a]));
    const r = el.getBoundingClientRect();
    let result: Promise<string | null>;
    try {
      result = Promise.resolve(
        menu({
          ...(title ? { title } : {}),
          items: actions.map(({ run: _, ...item }) => item),
          anchor: { x: r.x, y: r.y, width: r.width, height: r.height },
        }),
      );
    } catch (e) {
      result = Promise.reject(e);
    }
    void result
      .then(
        (id) => {
          const action = id === null ? undefined : byId.get(id);
          if (action !== undefined && action.disabled !== true) action.run();
        },
        () => fallback(),
      )
      .finally(() => {
        showing.current = false;
      });
  };
  return {
    onPointerDown: (e) => {
      e.preventDefault();
      // a pointer press is never the Space press's own click
      spacePress.current = false;
    },
    // focus left before the Space keyup (it never reaches this trigger now)
    onBlur: () => {
      spacePress.current = false;
    },
    onClick: (e) => {
      if (spacePress.current) return;
      show(e.currentTarget);
    },
    onKeyDown: (e) => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (e.key === " ") {
        if (e.repeat) return;
        spacePress.current = true;
      }
      show(e.currentTarget);
    },
    onKeyUp: (e) => {
      if (e.key !== " " || !spacePress.current) return;
      e.preventDefault();
      // the click a browser still fires for this keyup comes right after it
      setTimeout(() => {
        spacePress.current = false;
      }, 0);
    },
  };
}
