"use client";

// The host's implementation of `@capybara-hq/plugin-client` (client extensions spec §4.2, §9.4).
// In the browser the specifier `@capybara-hq/plugin-client` of a client bundle resolves, through
// the import map and the generated shim, to `PLUGIN_CLIENT` below; the web never imports the
// package (it reads the generated export list `lib/client-host/api.generated.ts`). The shapes
// copy the package's `context.ts`, `define.ts` and `hooks.ts`; keep them in step.
import {
  ActionRow,
  Avatar,
  Badge,
  Board,
  Button,
  CellTitle,
  DangerConfirm,
  DataTable,
  DetailPage,
  Dialog,
  EmptyState,
  Field,
  FilterChip,
  FormPage,
  FormSection,
  Icon,
  Input,
  ItemList,
  ItemListItem,
  Kbd,
  KeyValue,
  ListPage,
  Logo,
  Markdown,
  Menu,
  PersonName,
  Popover,
  PrincipalPicker,
  PropertySection,
  Segmented,
  Select,
  SettingsPage,
  Sheet,
  Spinner,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  Tooltip,
  useSizeClass,
  useViewportSegments,
  type ViewportSegment,
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
import { isParamRecord, safeHref } from "../../lib/page-params";
import { meQuery } from "../../lib/query/shell";
import type { UiActionRequest, UiView } from "../../lib/ui";
import { useTemplateMark } from "../extension-ui/template-guard";
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
) => Promise<{ view?: UiView; toast?: string; invalidate?: string[] }>;

/** A component query's state (`usePluginQuery`). */
export interface QueryState<T = unknown> {
  data: T | undefined;
  status: "loading" | "ready" | "error";
  error?: string;
  refetch(): void;
}

/** Where `useNavigate` may go: this page's params, another page of the plugin, a conversation. */
export type NavigateTarget =
  | { params: Record<string, string | null>; replace?: boolean }
  | { page: { id: string; params?: Record<string, string> } }
  | { conversation: string };

/**
 * What the host implements per rendered component; the hooks read it, nothing else. The functions
 * (`action`, `assetUrl`, `subscribe`) and `storage` stay referentially stable across renders.
 */
export interface HostApi extends HostServices {
  view: ViewState;
  action: ActionFn;
  /**
   * A hook (called during the component's render, by `usePluginQuery`): the component's named
   * query, cached by `(query, params)`, served `staleMs` (default 0) fresh.
   */
  query<T = unknown>(query: string, params: unknown, opts: { staleMs?: number }): QueryState<T>;
  /** The page's URL params (`org.page`); empty elsewhere. */
  pageParams: Record<string, string>;
  /** Navigates to a target {@link checkNavigateTarget} accepted. */
  navigate(to: NavigateTarget): void;
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
  sizeClass: "compact" | "medium" | "expanded" | null;
  viewportSegments: ViewportSegment[] | null;
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
  const sizeClass = useSizeClass();
  const viewportSegments = useViewportSegments();
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
      sizeClass,
      viewportSegments,
      subscribe,
    }),
    [
      scope,
      orgId,
      role,
      locale,
      run,
      reducedMotion,
      theme,
      storage,
      assetUrl,
      signIn,
      sizeClass,
      viewportSegments,
      subscribe,
    ],
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

/** One crumb of a page's path line. */
export interface PageCrumb {
  label: string;
  href?: string;
}

/**
 * The crumbs the host puts first in every forwarded template's path line: the org and the plugin
 * page's own name. Empty outside a plugin page (the /p host page provides them).
 */
const PageCrumbsContext = createContext<readonly PageCrumb[]>([]);
export const PageCrumbsProvider = PageCrumbsContext.Provider;

// ---- links in forwarded components ----

/**
 * A forwarded component's link, checked (`safeHref`: same-origin paths and http(s) URLs); any
 * other is dropped with a console warning, the rest of the item stays.
 */
function linkOf<T>(item: T, where: string): T {
  if (typeof item !== "object" || item === null || !("href" in item)) return item;
  const { href, ...rest } = item as { href?: unknown };
  if (href === undefined) return item;
  const ok = safeHref(href);
  if (ok === undefined) {
    console.warn(
      `${where}: dropped the link ${JSON.stringify(href)} (only same-origin paths and http(s) URLs)`,
    );
    return rest as T;
  }
  return { ...rest, href: ok } as T;
}

type MenuEntry = "separator" | { href?: unknown; submenu?: MenuEntry[] };

/** Menu items with every link checked, submenus too. */
function menuLinks<T>(items: T, where: string): T {
  if (!Array.isArray(items)) return items;
  return (items as MenuEntry[]).map((i) =>
    typeof i === "object" && i !== null && Array.isArray(i.submenu)
      ? { ...i, submenu: menuLinks(i.submenu, where) }
      : linkOf(i, where),
  ) as T;
}

type Header = {
  path?: PageCrumb[];
  actions?: ({ menu?: MenuEntry[] } & { href?: unknown })[];
  tabs?: { href?: unknown }[];
};

/** A page header with its links checked (path, actions and their menus, tabs). */
function headerLinks(header: Header, where: string): Header {
  const out: Header = { ...header };
  if (Array.isArray(header.path)) out.path = header.path.map((c) => linkOf(c, where));
  if (Array.isArray(header.actions)) {
    out.actions = header.actions.map((a) =>
      Array.isArray(a.menu) ? { ...a, menu: menuLinks(a.menu, where) } : linkOf(a, where),
    );
  }
  if (Array.isArray(header.tabs)) out.tabs = header.tabs.map((t) => linkOf(t, where));
  return out;
}

/** A forwarded component whose props are passed through `fix` first (its links checked). */
function withLinks<P extends object>(
  Base: ComponentType<never>,
  name: string,
  fix: (props: P) => P,
): ComponentType<P> {
  const Linked = (props: P) => createElement(Base as ComponentType<object>, fix(props));
  Linked.displayName = name;
  return Linked;
}

type TemplateProps = {
  header: Header;
  tabs?: { items?: { href?: unknown }[] };
  nav?: { items?: { href?: unknown }[] }[];
};

/**
 * A forwarded page template: the design template with the host's crumbs before the plugin's path,
 * its links checked, counted by the page frame's template guard (plugin full pages spec §2). A
 * missing `header` is a host error naming the template, not a TypeError inside it.
 */
function hostTemplate(Template: ComponentType<never>, name: string): ComponentType<TemplateProps> {
  const Hosted = (props: TemplateProps) => {
    useTemplateMark();
    const crumbs = useContext(PageCrumbsContext);
    if (typeof props.header !== "object" || props.header === null) {
      throw new Error(
        `${name}: \`header\` is required ({ title, path?, ... }); the host puts its own crumbs ` +
          "before `header.path`",
      );
    }
    const own = headerLinks(props.header, name);
    const header = { ...own, path: [...crumbs, ...(own.path ?? [])] };
    const out: TemplateProps = { ...props, header };
    if (props.tabs !== undefined && Array.isArray(props.tabs?.items)) {
      out.tabs = { ...props.tabs, items: props.tabs.items.map((t) => linkOf(t, name)) };
    }
    if (Array.isArray(props.nav)) {
      out.nav = props.nav.map((g) =>
        Array.isArray(g.items) ? { ...g, items: g.items.map((i) => linkOf(i, name)) } : g,
      );
    }
    return createElement(Template as ComponentType<object>, out);
  };
  Hosted.displayName = name;
  return Hosted;
}

/** The design components a client bundle may use (`DESIGN_SUBSET`; their props are frozen per API). */
export const HOST_DESIGN: Record<string, ComponentType<never>> = {
  ActionRow,
  Avatar,
  Badge,
  Board,
  Button,
  CellTitle,
  DangerConfirm,
  DataTable: withLinks<{ rowMenu?: (row: unknown) => unknown }>(
    DataTable as unknown as ComponentType<never>,
    "DataTable",
    (p) =>
      typeof p.rowMenu === "function"
        ? { ...p, rowMenu: (row: unknown) => menuLinks(p.rowMenu?.(row), "DataTable") }
        : p,
  ),
  DetailPage: hostTemplate(DetailPage as unknown as ComponentType<never>, "DetailPage"),
  Dialog,
  EmptyState: withLinks<{ action?: unknown }>(
    EmptyState as unknown as ComponentType<never>,
    "EmptyState",
    (p) => (p.action === undefined ? p : { ...p, action: linkOf(p.action, "EmptyState") }),
  ),
  Field,
  FilterChip,
  FormPage: hostTemplate(FormPage as unknown as ComponentType<never>, "FormPage"),
  FormSection,
  Icon,
  Input,
  ItemList: withLinks<{ rows?: unknown[] }>(
    ItemList as unknown as ComponentType<never>,
    "ItemList",
    (p) => (Array.isArray(p.rows) ? { ...p, rows: p.rows.map((r) => linkOf(r, "ItemList")) } : p),
  ),
  ItemListItem: withLinks<object>(
    ItemListItem as unknown as ComponentType<never>,
    "ItemListItem",
    (p) => linkOf(p, "ItemListItem"),
  ),
  Kbd,
  KeyValue,
  ListPage: hostTemplate(ListPage as unknown as ComponentType<never>, "ListPage"),
  Logo,
  Markdown,
  Menu: withLinks<{ items?: unknown }>(Menu as unknown as ComponentType<never>, "Menu", (p) => ({
    ...p,
    items: menuLinks(p.items, "Menu"),
  })),
  PersonName,
  Popover,
  PrincipalPicker,
  PropertySection,
  Segmented,
  Select,
  SettingsPage: hostTemplate(SettingsPage as unknown as ComponentType<never>, "SettingsPage"),
  Sheet,
  Spinner,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  Tooltip,
  ViewBlocks,
} as unknown as Record<string, ComponentType<never>>;

const NAV_ERR = "navigate target must be { params }, { page } or { conversation }";

/**
 * The host's own check of a `useNavigate` target (the package checks the shape too, the host does
 * not rely on it): exactly one of `{ params }` (a plain object of string or null values, with an
 * optional boolean `replace`), `{ page: { id, params? } }` (string params) or `{ conversation }`
 * (an id). Anything else throws.
 */
export function checkNavigateTarget(to: unknown): NavigateTarget {
  const fail = (): never => {
    let shown: string;
    try {
      shown = JSON.stringify(to) ?? String(to);
    } catch {
      shown = String(to);
    }
    throw new Error(`${NAV_ERR}: got ${shown}`);
  };
  if (typeof to !== "object" || to === null || Array.isArray(to)) return fail();
  const o = to as Record<string, unknown>;
  const names = Object.keys(o).filter((k) => k !== "replace");
  if (names.length !== 1) return fail();
  if (o.replace !== undefined && (names[0] !== "params" || typeof o.replace !== "boolean")) {
    return fail();
  }
  if (names[0] === "params") {
    if (!isParamRecord(o.params, true)) return fail();
    return to as NavigateTarget;
  }
  if (names[0] === "page") {
    const page = o.page as Record<string, unknown> | null;
    if (typeof page !== "object" || page === null || Array.isArray(page)) return fail();
    if (typeof page.id !== "string" || page.id === "") return fail();
    if (Object.keys(page).some((k) => k !== "id" && k !== "params")) return fail();
    if (page.params !== undefined && !isParamRecord(page.params, false)) return fail();
    return to as NavigateTarget;
  }
  if (names[0] === "conversation") {
    if (typeof o.conversation !== "string" || o.conversation === "") return fail();
    return to as NavigateTarget;
  }
  return fail();
}

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
  useSizeClass: () => useHost("useSizeClass").api.sizeClass,
  useViewportSegments: () => useHost("useViewportSegments").api.viewportSegments,
  useNavigate: () => {
    const { navigate } = useHost("useNavigate").api;
    return (to: unknown) => navigate(checkNavigateTarget(to));
  },
  usePageParams: () => useHost("usePageParams").api.pageParams,
  usePluginQuery: (query: string, params: unknown = null, opts: { staleMs?: number } = {}) =>
    useHost("usePluginQuery").api.query(query, params, opts),
};
