import { useContext, useEffect, useRef } from "react";
import {
  type ActionFn,
  HostContext,
  type HostContextValue,
  PluginClientContextError,
  type ViewState,
} from "./context.js";
import type { CapybaraEvent, CapybaraEventType, ClientStorage, RunState, SignIn } from "./types.js";

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
