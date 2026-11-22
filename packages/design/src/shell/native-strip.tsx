import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { initialOf } from "../display/initial";
import type { NavBadge } from "../display/nav-badge";
import {
  NATIVE_MENU_ID,
  NATIVE_NAV_ACCOUNT_NAME,
  NATIVE_NAV_LIMITS,
  type NativeNavHandle,
  type NativeNavState,
  type NativeSectionId,
  useHaptics,
} from "../native";
import { popOverlaysThen } from "../overlays/use-overlay-history";
import { useDesignT } from "../provider";
import { AccountSheet } from "./account-sheet";
import type { DrawerNavData } from "./nav-drawer";
import type { ShellPrimary } from "./shell-page";

/** The pill's top item without a page primary: the new conversation (interaction model §10.3). */
export const NEW_CONVERSATION_ACTION = "new-conversation";

export type NativeStripInput = {
  nativeNav: NativeNavHandle | undefined;
  drawer: DrawerNavData | undefined;
  pathname: string | undefined;
  /** The page is a chat surface: the chats section is current. */
  surface: boolean;
  /** The page's registered primary (`ShellPage.primary`). */
  primary: ShellPrimary | undefined;
  /** The class is compact after hydration: only there the pill carries the page's primary (D14). */
  compact: boolean;
  /** The shell has a command palette: the pill ends with Search. */
  searchable: boolean;
  /** Draw nothing on `<html>` (the reference set). */
  reference: boolean;
  onNavigate: ((href: string, options?: { transition?: "none" }) => void) | undefined;
  /** The shell's route-change bookkeeping: a strip move swaps at once (no slide). */
  instantRoute: MutableRefObject<string | null>;
  openPalette(): void;
  /** Closes the shell's own overlays (the drawer, the palette) at once. */
  closeOverlays(): void;
};

/**
 * The AppShell's side of the native strip (`nav@1`, mobile app spec §6.1; interaction model
 * §10.2–10.4): the strip's state from the drawer's data and the route (the sections with the
 * inbox count, Search when there is a palette, the current section, the pill's top item: the
 * page's primary on compact, else New conversation; the account avatar), sent once per change;
 * `<html data-native-nav>` while the handle is there; the taps: a section navigates to its root
 * without a slide, Search opens the palette, the top item runs the primary (else opens the new
 * conversation), the avatar opens the account sheet. Every tap closes an open overlay first, as
 * back would (on a touch window its history entries are popped and the act runs once that
 * landed). Returns the account sheet the avatar opens (null without a strip).
 */
export function useNativeStrip(input: NativeStripInput): ReactNode {
  const t = useDesignT();
  const haptics = useHaptics();
  const [accountOpen, setAccountOpen] = useState(false);
  const { nativeNav, drawer, reference } = input;
  const hasNav = nativeNav !== undefined;
  // A shell before the minor version (no `onAction`) validates the old shape only: the four
  // sections, current and menu, nothing else (mobile app spec §5.2).
  const legacy = nativeNav !== undefined && typeof nativeNav.onAction !== "function";
  // the pill carries a primary with a label (an empty one leaves the new conversation)
  const primary = input.compact && input.primary?.label ? input.primary : undefined;
  const account = drawer ? accountOf(drawer.account.name, drawer.account.avatar) : null;
  const state: NativeNavState | null = !drawer
    ? null
    : legacy
      ? {
          items: [
            { id: "chats" as const, label: navLabel(t("shell.chats")) },
            ...drawer.sections.map((s) => ({
              id: s.id,
              label: navLabel(s.label),
              ...navBadge(s.badge),
            })),
          ],
          current: currentSection(input.pathname, input.surface, drawer),
          menu: null,
        }
      : {
          items: [
            { id: "chats" as const, label: navLabel(t("shell.chats")) },
            ...drawer.sections.map((s) => ({
              id: s.id,
              label: navLabel(s.label),
              ...navBadge(s.badge),
            })),
            ...(input.searchable
              ? [{ id: "search" as const, label: navLabel(t("shell.searchShort")) }]
              : []),
          ],
          current: currentSection(input.pathname, input.surface, drawer),
          menu: null,
          action: primary
            ? {
                id: NATIVE_MENU_ID.test(primary.id) ? primary.id : "primary",
                label: navLabel(primary.label),
                icon: primary.icon ?? "plus",
              }
            : {
                id: NEW_CONVERSATION_ACTION,
                label: navLabel(drawer.newConversation.label),
                icon: "square-pen",
              },
          ...(account ? { account } : {}),
        };
  const key = state === null ? null : JSON.stringify(state);
  const sent = useRef<string | null>(null);
  const latest = useRef({ input, state, primary, haptics, accountOpen });
  latest.current = { input, state, primary, haptics, accountOpen };
  // `nav.set` is the one capability call made from an effect: a state push, not confirming. Only
  // the handle's presence and the state key it: an equivalent new handle sends nothing.
  useEffect(() => {
    const { input: now, state: next } = latest.current;
    if (!hasNav) {
      sent.current = null;
      return;
    }
    if (now.nativeNav === undefined || next === null || sent.current === key) return;
    sent.current = key;
    try {
      now.nativeNav.set(next);
    } catch {
      // the strip keeps its last state
    }
  }, [hasNav, key]);
  // `<html data-native-nav>` (set before the first paint by the environment script) also reaches
  // the drawer and the menus, which portal out of the shell element: set while the handle is
  // there, cleared once it goes (the strip went away), never touched before a handle was seen.
  const hadNav = useRef(false);
  useEffect(() => {
    if (reference) return;
    const root = document.documentElement;
    if (hasNav) {
      hadNav.current = true;
      root.setAttribute("data-native-nav", "");
    } else if (hadNav.current) {
      hadNav.current = false;
      root.removeAttribute("data-native-nav");
    }
    if (!hasNav) setAccountOpen(false);
  }, [hasNav, reference]);
  // The strip's taps: subscribed per handle (resubscribing sends no state).
  useEffect(() => {
    if (nativeNav === undefined) return;
    const offs: (() => void)[] = [];
    const listen = (subscribe: (() => unknown) | undefined) => {
      if (subscribe === undefined) return;
      try {
        const off = subscribe();
        if (typeof off === "function") offs.push(off as () => void);
      } catch {
        // a shell that cannot subscribe: its taps do nothing
      }
    };
    // An open overlay closes first (as back would, §10.2): on a touch window its history entries
    // are popped and `act` runs once that landed, else everything closes at once.
    const closeThen = (act: () => void) => {
      const popped = popOverlaysThen(act);
      latest.current.input.closeOverlays();
      setAccountOpen(false);
      if (!popped) act();
    };
    const go = (href: string, options?: { transition: "none" }) => {
      const nav = latest.current.input.onNavigate;
      if (nav) nav(href, ...(options ? [options] : []));
      else window.location.assign(href);
    };
    listen(() =>
      nativeNav.onSelect((id) => {
        const { input: now, haptics: buzz } = latest.current;
        if (id === "search") {
          if (!now.searchable) return;
          buzz("selection");
          closeThen(() => latest.current.input.openPalette());
          return;
        }
        const href = now.drawer === undefined ? undefined : sectionHref(id, now.drawer);
        if (href === undefined) return;
        buzz("selection");
        // a tap on the section whose root is already shown moves nowhere
        closeThen(() => {
          if (href === latest.current.input.pathname) return;
          // a tab switch swaps at once (no slide)
          latest.current.input.instantRoute.current = href;
          go(href, { transition: "none" });
        });
      }),
    );
    listen(
      nativeNav.onAction &&
        (() =>
          nativeNav.onAction?.(() => {
            closeThen(() => {
              const { input: now, primary: p } = latest.current;
              if (p !== undefined) p.run();
              else if (now.drawer !== undefined) {
                const href = now.drawer.newConversation.href;
                if (href === now.pathname) return;
                // like a strip selection: swaps at once (no slide)
                now.instantRoute.current = href;
                go(href, { transition: "none" });
              }
            });
          })),
    );
    listen(
      nativeNav.onAccount &&
        (() =>
          nativeNav.onAccount?.(() => {
            // a second tap while the sheet is open closes it (no close and reopen)
            if (latest.current.accountOpen) {
              setAccountOpen(false);
              return;
            }
            closeThen(() => setAccountOpen(true));
          })),
    );
    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          // already gone
        }
      }
    };
  }, [nativeNav]);
  if (!hasNav || drawer === undefined) return null;
  return <AccountSheet open={accountOpen} onOpenChange={setAccountOpen} data={drawer.account} />;
}

/** A label within `navLabel` characters (the strip's bound; a longer one is cut). */
function navLabel(label: string, max: number = NATIVE_NAV_LIMITS.label): string {
  const chars = Array.from(label);
  return chars.length > max ? chars.slice(0, max).join("") : label;
}

/** A badge in the strip's shape: a count within `navCount`, `countMore` past it; none at 0. */
function navBadge(badge: NavBadge | undefined): { count?: number; countMore?: boolean } {
  const n = badge?.count ?? 0;
  if (!(n > 0)) return {};
  const count = Math.min(Math.floor(n), NATIVE_NAV_LIMITS.count);
  const more = badge?.more === true || n > NATIVE_NAV_LIMITS.count;
  return { count, ...(more ? { countMore: true } : {}) };
}

/**
 * The account avatar's state: the name (1..navAccountName), its initial and the image's absolute
 * URL when it is https, or plain http on the page's own origin (any other source, data: or blob:
 * included, is not sent; the shell draws the initial). Null for an
 * empty name: no avatar.
 */
function accountOf(
  name: string,
  avatar: DrawerNavData["account"]["avatar"],
): NonNullable<NativeNavState["account"]> | null {
  const short = navLabel(name.trim(), NATIVE_NAV_ACCOUNT_NAME);
  if (short === "") return null;
  let avatarUrl: string | undefined;
  if (avatar?.kind === "image" && typeof window !== "undefined") {
    try {
      const url = new URL(avatar.src, window.location.href);
      // https from anywhere; plain http only from the page's own origin
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" && url.origin === window.location.origin)
      )
        avatarUrl = url.href;
    } catch {
      // an unparsable source: the initial
    }
  }
  return { name: short, initial: initialOf(short), ...(avatarUrl ? { avatarUrl } : {}) };
}

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/** The section a route belongs to: chats for a chat surface and the conversations list. */
function currentSection(
  pathname: string | undefined,
  surface: boolean,
  drawer: DrawerNavData,
): NativeSectionId | null {
  if (surface) return "chats";
  if (pathname === undefined) return null;
  if (under(pathname, drawer.allConversations.href)) return "chats";
  return drawer.sections.find((s) => under(pathname, s.href))?.id ?? null;
}

/** A section's root: the new conversation for chats, else the drawer's entry. */
function sectionHref(id: NativeSectionId, drawer: DrawerNavData): string | undefined {
  if (id === "chats") return drawer.newConversation.href;
  return drawer.sections.find((s) => s.id === id)?.href;
}
