"use client";

// The host's implementation of `@capybara-hq/plugin-client` (client extensions spec §4.2, §9.4).
// In the browser the specifier `@capybara-hq/plugin-client` of a client bundle resolves, through
// the import map and the generated shim, to `PLUGIN_CLIENT` below; the web never imports the
// package (it reads the generated export list `lib/client-host/api.generated.ts`). The shapes
// copy the package's `context.ts`, `define.ts` and `hooks.ts`; keep them in step.
import {
  Badge,
  Button,
  Icon,
  Kbd,
  KeyValue,
  Logo,
  PropertySection,
  Select,
  Spinner,
  Stack,
  Text,
  Tooltip,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale as useIntlLocale } from "next-intl";
import {
  type ComponentType,
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ClientExtensionItem } from "../../lib/client-extensions";
import { CLIENT_API_VERSION } from "../../lib/client-host/api.generated";
import { meQuery } from "../../lib/query/shell";
import type { UiActionRequest, UiView } from "../../lib/ui";
import { useResolvedTheme } from "../theme-root";
import { UiViewRenderer } from "../ui-view/UiViewRenderer";
import type { CapybaraEvent } from "./events";
import type { ClientApi, ClientComponent, ClientExtension } from "./registry";
import { useClientHostControls } from "./registry";
import { type RunState, useRunStateValue } from "./run-state";

/** Thrown by a hook used outside a component the host rendered. */
export class PluginClientContextError extends Error {
  constructor(hook: string) {
    super(
      `${hook}() can only be used inside a component the Capybara host rendered ` +
        "(a component registered with defineComponent); there is no host context here.",
    );
    this.name = "PluginClientContextError";
  }
}

export type ClientRole = "owner" | "admin" | "member" | "guest" | "superAdmin";

const ORG_ROLES = new Set(["owner", "admin", "member", "guest"]);
const isOrgRole = (r: string | undefined): r is Exclude<ClientRole, "superAdmin"> =>
  r !== undefined && ORG_ROLES.has(r);

export interface ViewState {
  view: UiView | null;
  status: "loading" | "ready" | "failed";
  retry(): void;
}

export type ActionFn = (
  actionId: string,
  input?: { payload?: unknown; answer?: Record<string, unknown> },
) => Promise<{ view?: UiView; toast?: string }>;

/**
 * What the host implements per rendered component; the hooks read it, nothing else. The functions
 * (`action`, `assetUrl`, `subscribe`) and `storage` stay referentially stable across renders.
 */
export interface HostApi extends HostServices {
  view: ViewState;
  action: ActionFn;
}

/** The part of {@link HostApi} that does not depend on the component's view. */
export interface HostServices {
  orgId: string | null;
  role: ClientRole;
  locale: "zh" | "en";
  runState: RunState;
  conversationId: string | null;
  reducedMotion: boolean;
  theme: { key: string | null; scheme: "dark" | "light" };
  storage: ClientApi["storage"];
  assetUrl(path: string): string;
  signIn: ClientApi["signIn"];
  subscribe(handler: (e: CapybaraEvent) => void): () => void;
}

export interface HostContextValue {
  plugin: string;
  contribution: string;
  slot: string;
  args: Record<string, unknown>;
  api: HostApi;
}

/** Provided per rendered client component (Task 18's `ClientComponentBlock`). */
export const HostContext = createContext<HostContextValue | null>(null);

/** Where the document's client code runs: the org's workspace or a platform page of the console. */
export interface HostScope {
  scope: "org" | "admin";
  orgId: string | null;
}
const ScopeContext = createContext<HostScope>({ scope: "org", orgId: null });
export const HostScopeProvider = ScopeContext.Provider;

/** `localStorage` / `sessionStorage` under `cap-ext:<plugin>:`; a blocked store reads as empty. */
export function createPrefixedStorage(plugin: string): ClientApi["storage"] {
  const prefix = `cap-ext:${plugin}:`;
  const store = (scope: "local" | "session"): Storage | null => {
    try {
      return scope === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key, scope = "local") {
      try {
        return store(scope)?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value, scope = "local") {
      try {
        const s = store(scope);
        if (!s) return;
        if (value === null) s.removeItem(prefix + key);
        else s.setItem(prefix + key, value);
      } catch {
        // a blocked or full store: ignore
      }
    },
  };
}

/**
 * The URL of a file under `dist/client/assets/` of the item's build (`boot.ogg`,
 * `img/a.png`): each segment encoded, `.` and `..` segments dropped, so it never leaves the build.
 */
export function assetUrlOf(item: Pick<ClientExtensionItem, "plugin" | "build">, path: string) {
  const segs = path
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .map(encodeURIComponent);
  return `/api/v1/client/${encodeURIComponent(item.plugin)}/${encodeURIComponent(item.build)}/assets/${segs.join("/")}`;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(notify: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(REDUCED_MOTION);
  mql.addEventListener?.("change", notify);
  return () => mql.removeEventListener?.("change", notify);
}
const reducedMotionNow = () =>
  typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;

/** `prefers-reduced-motion` (client components render only in the browser, after hydration). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionNow, () => false);
}

function subscribeScheme(notify: () => void): () => void {
  const mo = new MutationObserver(notify);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}
const schemeNow = (): "dark" | "light" =>
  document.documentElement.dataset.theme === "light" ? "light" : "dark";

let fallbackId: string | null = null;
/** A random id fixed for this document: the sign-in id of a plugin missing from the set. */
function documentFallbackId(): string {
  fallbackId ??= `doc-${crypto.randomUUID()}`;
  return fallbackId;
}

/** The listener api of a plugin's `events` (no React context there). */
export function clientApiFor(
  item: Pick<ClientExtensionItem, "plugin" | "build" | "signInId">,
  locale: "zh" | "en",
): ClientApi {
  return {
    locale,
    reducedMotion: reducedMotionNow(),
    storage: createPrefixedStorage(item.plugin),
    assetUrl: (path) => assetUrlOf(item, path),
    signIn: { id: item.signInId },
  };
}

/**
 * The view-independent host api of one component of `plugin`: access, locale, run state, motion,
 * theme, storage, asset URLs, the sign-in (the document's shell read: a sign-in is a new
 * document) and client events (delivered while the plugin is active; a throwing
 * handler counts against its crash budget). Task 18 adds the component's view and action.
 */
export function useHostServices(plugin: string, contribution: string | null): HostServices {
  const controls = useClientHostControls();
  const { scope, orgId } = useContext(ScopeContext);
  const me = useQuery(meQuery()).data;
  const intl = useIntlLocale();
  const locale: "zh" | "en" = intl === "zh" ? "zh" : "en";
  const run = useRunStateValue();
  const reducedMotion = useReducedMotion();
  const themeKey = useResolvedTheme()?.key ?? null;
  const scheme = useSyncExternalStore(subscribeScheme, schemeNow, () => "dark" as const);
  const member = me?.memberships.find((m) => m.orgId === orgId)?.role;
  const role: ClientRole = scope === "admin" ? "superAdmin" : isOrgRole(member) ? member : "guest";
  const item = controls.item(plugin);
  const build = item?.build ?? "";
  // Components render only for items of the document's set, so `item` is there; if it ever is
  // not, a per-document id errs towards "a new sign-in" rather than a constant that never changes.
  const signInId = item?.signInId ?? documentFallbackId();
  const storage = useMemo(() => createPrefixedStorage(plugin), [plugin]);
  const assetUrl = useMemo(
    () => (path: string) => assetUrlOf({ plugin, build }, path),
    [plugin, build],
  );
  // Stable across renders (useCapybaraEvents resubscribes when it changes).
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const subscribe = useMemo(
    () => (handler: (e: CapybaraEvent) => void) =>
      controlsRef.current.subscribe(plugin, contribution, handler),
    [plugin, contribution],
  );
  const theme = useMemo(() => ({ key: themeKey, scheme }), [themeKey, scheme]);
  const signIn = useMemo(() => ({ id: signInId }), [signInId]);
  return useMemo(
    () => ({
      orgId: scope === "admin" ? null : orgId,
      role,
      locale,
      runState: run.state,
      conversationId: run.conversationId,
      reducedMotion,
      theme,
      storage,
      assetUrl,
      signIn,
      subscribe,
    }),
    [scope, orgId, role, locale, run, reducedMotion, theme, storage, assetUrl, signIn, subscribe],
  );
}

// ---- the module the shim `plugin-client.mjs` re-exports ----

function useHost(hook: string): HostContextValue {
  const host = useContext(HostContext);
  if (!host) throw new PluginClientContextError(hook);
  return host;
}

const ROLE_RANK = { guest: 0, member: 1, admin: 2, owner: 2, superAdmin: 3 } as const;

function useCapybaraEvents(
  handler: (e: CapybaraEvent) => void,
  types?: readonly CapybaraEvent["type"][],
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

/** The host's renderer of a `UiView` (the one extension views use); actions go to `useAction`. */
function ViewBlocks({ view }: { view: UiView }) {
  const { api } = useHost("ViewBlocks");
  const onAction = async (req: UiActionRequest) => {
    await api.action(req.actionId, {
      ...(req.payload !== undefined && { payload: req.payload }),
      ...(req.answer !== undefined && { answer: req.answer as Record<string, unknown> }),
    });
  };
  return createElement(UiViewRenderer, { view, onAction });
}

/** The design components a client bundle may use (`DESIGN_SUBSET`; their props are frozen per API). */
export const HOST_DESIGN: Record<string, ComponentType<never>> = {
  Badge,
  Button,
  Icon,
  Kbd,
  KeyValue,
  Logo,
  PropertySection,
  Select,
  Spinner,
  Stack,
  Text,
  Tooltip,
  ViewBlocks,
} as unknown as Record<string, ComponentType<never>>;

/** Every runtime export of `@capybara-hq/plugin-client`, implemented by the host. */
export const PLUGIN_CLIENT: Record<string, unknown> = {
  ...HOST_DESIGN,
  CLIENT_API_VERSION,
  PluginClientContextError,
  defineClientExtension: (def: Omit<ClientExtension, "apiVersion">): ClientExtension => ({
    ...def,
    apiVersion: CLIENT_API_VERSION,
  }),
  defineComponent: (slot: string, render: ClientComponent["render"]): ClientComponent => ({
    slot,
    render,
  }),
  useView: (): ViewState => useHost("useView").api.view,
  useAction: (): ActionFn => useHost("useAction").api.action,
  useAccess: () => {
    const { orgId, role } = useHost("useAccess").api;
    return {
      orgId,
      role,
      atLeast: (min: keyof typeof ROLE_RANK) => ROLE_RANK[role] >= ROLE_RANK[min],
    };
  },
  useLocale: () => {
    const { locale } = useHost("useLocale").api;
    return { locale, t: (text: { zh: string; en: string }) => text[locale] };
  },
  useRunState: () => {
    const { runState, conversationId } = useHost("useRunState").api;
    return { state: runState, conversationId };
  },
  useCapybaraEvents,
  usePrefersReducedMotion: () => useHost("usePrefersReducedMotion").api.reducedMotion,
  useTheme: () => useHost("useTheme").api.theme,
  useClientStorage: () => useHost("useClientStorage").api.storage,
  useAssetUrl: () => useHost("useAssetUrl").api.assetUrl,
  useSignIn: () => useHost("useSignIn").api.signIn,
};
