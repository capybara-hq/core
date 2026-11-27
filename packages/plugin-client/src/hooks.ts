import { useContext, useEffect, useRef } from "react";
import {
  type ActionFn,
  HostContext,
  type HostContextValue,
  type NavigateTarget,
  PluginClientContextError,
  type QueryState,
  type ViewState,
} from "./context.js";
import type {
  CapybaraEvent,
  CapybaraEventType,
  ClientStorage,
  JsonValue,
  RunState,
  SignIn,
  SizeClass,
  ViewportSegment,
} from "./types.js";

function useHost(hook: string): HostContextValue {
  const host = useContext(HostContext);
  if (!host) throw new PluginClientContextError(hook);
  return host;
}

/** The view the extension registered under this component's id, refreshed like any view. */
export function useView(): ViewState {
  return useHost("useView").api.view;
}

/** Calls the `ctx.ui.action` registered under this component's id. */
export function useAction(): ActionFn {
  return useHost("useAction").api.action;
}

const ROLE_RANK = { guest: 0, member: 1, admin: 2, owner: 2, superAdmin: 3 } as const;

export function useAccess(): {
  orgId: string | null;
  role: "owner" | "admin" | "member" | "guest" | "superAdmin";
  atLeast(role: "guest" | "member" | "admin" | "superAdmin"): boolean;
} {
  const { orgId, role } = useHost("useAccess").api;
  return { orgId, role, atLeast: (min) => ROLE_RANK[role] >= ROLE_RANK[min] };
}

export function useLocale(): { locale: "zh" | "en"; t(text: { zh: string; en: string }): string } {
  const { locale } = useHost("useLocale").api;
  return { locale, t: (text) => text[locale] };
}

/** The open conversation's run state; "idle" on pages without a conversation. */
export function useRunState(): { state: RunState; conversationId: string | null } {
  const { runState, conversationId } = useHost("useRunState").api;
  return { state: runState, conversationId };
}

/** Calls `handler` for each client event; `types` filters. */
export function useCapybaraEvents(
  handler: (e: CapybaraEvent) => void,
  types?: readonly CapybaraEventType[],
): void {
  const { api } = useHost("useCapybaraEvents");
  const latest = useRef({ handler, types });
  latest.current = { handler, types };
  const { subscribe } = api;
  useEffect(
    () =>
      subscribe((e) => {
        const { handler: h, types: t } = latest.current;
        if (!t || t.includes(e.type)) h(e);
      }),
    [subscribe],
  );
}

export function usePrefersReducedMotion(): boolean {
  return useHost("usePrefersReducedMotion").api.reducedMotion;
}

/** The resolved theme: `key` is "<plugin>/<theme file id>", null = built-in. */
export function useTheme(): { key: string | null; scheme: "dark" | "light" } {
  return useHost("useTheme").api.theme;
}

export function useClientStorage(): ClientStorage {
  return useHost("useClientStorage").api.storage;
}

/** URL of a file under dist/client/assets/ of this plugin's build. */
export function useAssetUrl(): (path: string) => string {
  return useHost("useAssetUrl").api.assetUrl;
}

/**
 * The viewer's sign-in for this plugin: `id` stays the same for one sign-in and changes on the
 * next one (once per sign-in: compare it with the id stored when the thing last ran).
 */
export function useSignIn(): SignIn {
  return useHost("useSignIn").api.signIn;
}

/**
 * The window's size class (`compact` below 600 CSS px, `medium` up to 840, else `expanded`),
 * live as the window changes; `null` until the host knows it. Layout that can be expressed in CSS
 * should be: this is for behavior that cannot.
 */
export function useSizeClass(): SizeClass | null {
  return useHost("useSizeClass").api.sizeClass;
}

/** The two screens of a window that spans a folded or dual-screen display, else `null`. */
export function useViewportSegments(): ViewportSegment[] | null {
  return useHost("useViewportSegments").api.viewportSegments;
}

/**
 * Runs the `ctx.ui.query` registered under this component's id with `params` (JSON); the result is
 * cached by `(query, params)` and refetched when an action returns `invalidate` naming `query`.
 * `staleMs` (default 0) is how long a cached result is served without a refetch.
 */
export function usePluginQuery<T = unknown>(
  query: string,
  params: JsonValue = null,
  opts: { staleMs?: number } = {},
): QueryState<T> {
  return useHost("usePluginQuery").api.query<T>(query, params, opts);
}

/** The page's URL params (`org.page` components); an empty object elsewhere. */
export function usePageParams(): Record<string, string> {
  return useHost("usePageParams").api.pageParams;
}

const NAV_ERR = "navigate target must be { params }, { page } or { conversation }";

/**
 * Navigates within the plugin: `{ params }` changes this page's params (`null` removes one),
 * `{ page }` opens another `org.page` of the plugin, `{ conversation }` opens a conversation.
 * Anything else throws `Error("navigate target …")`.
 */
export function useNavigate(): (to: NavigateTarget) => void {
  const { navigate } = useHost("useNavigate").api;
  return (to) => {
    if (typeof to !== "object" || to === null) throw new Error(NAV_ERR);
    const keys = Object.keys(to).filter((k) => k !== "replace");
    const o = to as Record<string, unknown>;
    const ok =
      keys.length === 1 &&
      ((keys[0] === "params" && typeof o.params === "object" && o.params !== null) ||
        (keys[0] === "page" &&
          typeof o.page === "object" &&
          o.page !== null &&
          typeof (o.page as { id?: unknown }).id === "string") ||
        (keys[0] === "conversation" && typeof o.conversation === "string")) &&
      (o.replace === undefined || (keys[0] === "params" && typeof o.replace === "boolean"));
    if (!ok) throw new Error(`${NAV_ERR}: got ${JSON.stringify(to)}`);
    navigate(to);
  };
}
