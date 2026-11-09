"use client";

import { SafeModeBanner, useToast } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import {
  type ClientExtensionItem,
  type ClientExtensionsResponse,
  type ClientReportKind,
  type ClientReportScope,
  type ClientScopeKey,
  setHasCode,
  withSafeUi,
} from "../../lib/client-extensions";
import { CLIENT_API_VERSION } from "../../lib/client-host/api.generated";
import { retryOnMountOf } from "../../lib/query/client";
import {
  adminClientExtensionsQuery,
  clientExtensionsQuery,
} from "../../lib/query/client-extensions";
import { useClientBoundary } from "./boundary";
import { createCrashCounter, disableForSession, isDisabledForSession } from "./crash-budget";
import { type CapybaraEvent, subscribeClientEvents } from "./events";
import { clientApiFor, HOST_DESIGN, HostScopeProvider, PLUGIN_CLIENT } from "./host-api";
import {
  type ClientHostControls,
  ClientHostControlsProvider,
  type ClientRegistry,
  ClientRegistryProvider,
  ShellBannerProvider,
  validateEntry,
} from "./registry";
import { createReporter, reportMessage } from "./reports";

/** `CLIENT_LIMITS.loadTimeoutMs`: an entry that has not loaded by then failed. */
export const CLIENT_LOAD_TIMEOUT_MS = 10_000;

/** The global the generated shims (`/_capybara/client-host/<webBuild>/*.mjs`) re-export from. */
export const HOST_GLOBAL = "__CAPYBARA_CLIENT_HOST__";

/** The plugins' stylesheets React hoisted into `<head>` (`ClientExtensionsHead`). */
const EXTENSION_SHEETS = 'link[rel="stylesheet"][data-precedence="extensions"]';

interface ClientHostProps {
  /**
   * The client set: the first value is the document's (what the head preloaded; modules cannot be
   * unloaded, so it is fixed for the document), later values the live shell read, which only
   * withdraws (a plugin no longer listed stops rendering); a new plugin or build loads at the next
   * document, and a notice offers that reload.
   */
  set: ClientExtensionsResponse | null;
  /**
   * Safe mode (`?safe-ui=1` or its session cookie): nothing is imported, every plugin stylesheet is
   * disabled and the banner shows when client code exists. Pinned at the first render: it holds
   * for the document whatever a later layout render says.
   */
  safe: boolean;
  /** Workspace pages (`org`) or a platform page of the admin console (`admin`). */
  scope: "org" | "admin";
  orgId: string | null;
  /** False when the web build has no host shims: entries are not imported (stylesheets apply). */
  hostReady?: boolean;
  children: ReactNode;
}

/**
 * The client host (client extensions spec §9.4, §9.6, §10, §11): in its first layout effect it sets
 * the host global (React, React DOM, the JSX runtime, the plugin-client implementation, the design
 * subset, `CLIENT_API_VERSION`), then `import()`s each entry of the document's set in plugin-name
 * order, in parallel (10 s each), checks it (`validateEntry`) and keeps the registry. It delivers
 * client events to the plugins' `events`, applies the crash budget, sends the reports, disables
 * the stylesheets of plugins no longer listed, offers a reload when the live set adds client code
 * and turns client navigations across the boundary into document loads. Nothing runs on the server or in the first client render: the registry is
 * empty until the effect, so hydration never mismatches.
 */
export function ClientHost({
  set,
  safe: safeProp,
  scope,
  orgId,
  hostReady = true,
  children,
}: ClientHostProps) {
  const t = useTranslations("clientExtensions");
  const locale: "zh" | "en" = useLocale() === "zh" ? "zh" : "en";
  const toast = useToast();
  const qc = useQueryClient();
  // Safe mode and the document's set (safe mode: nothing loads), fixed at the first render.
  const [safe] = useState(safeProp);
  const [doc] = useState<ClientExtensionsResponse | null>(() => (safe ? null : set));
  const [docItems] = useState<ClientExtensionItem[]>(() =>
    doc?.enabled === true
      ? doc.items
          .map((i) => (hostReady ? i : { ...i, entry: null }))
          .sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0))
      : [],
  );
  const loaded = docItems.length > 0;
  const [registry, setRegistry] = useState<ClientRegistry>({});
  // A non-click navigation crossed the boundary: the new page committed in this document, which
  // the client code must leave (every plugin off) until the document load replaces it.
  const [leaving, setLeaving] = useState(false);
  const reportScope: ClientReportScope | null =
    scope === "admin" ? { kind: "admin" } : orgId === null ? null : { kind: "org", orgId };
  const [report] = useState(() => createReporter(reportScope));
  const [counter] = useState(() => createCrashCounter());

  // A plugin is listed while the live read names it (a failed or missing read changes nothing).
  const live = set ?? doc;
  const listed = useMemo(
    () => new Set(live?.enabled === true ? live.items.map((i) => i.plugin) : []),
    [live],
  );
  const exposed = useMemo<ClientRegistry>(() => {
    const out: ClientRegistry = {};
    for (const [plugin, entry] of Object.entries(registry)) {
      out[plugin] = listed.has(plugin) && !leaving ? entry : { status: "disabled" };
    }
    return out;
  }, [registry, listed, leaving]);
  const exposedRef = useRef(exposed);
  exposedRef.current = exposed;
  const itemOf = useCallback(
    (plugin: string) => docItems.find((i) => i.plugin === plugin),
    [docItems],
  );

  const navigate = useCallback((href: string) => ClientHost.navigate(href), []);
  const safeReload = useCallback(
    () => navigate(withSafeUi(`${location.pathname}${location.search}${location.hash}`)),
    [navigate],
  );

  /**
   * One error of a plugin: reported once per kind and contribution, counted by the budget. A
   * contribution's error counts once per document like its report (one brand drawn in the rail and
   * in the open drawer must not spend the budget on its first crash); an error of no contribution
   * (a listener, an uncaught error) counts each time.
   */
  const counted = useRef(new Set<string>());
  const fail = useCallback(
    (
      item: ClientExtensionItem,
      kind: Exclude<ClientReportKind, "budget">,
      contribution: string | null,
      message: string,
    ) => {
      report({ plugin: item.plugin, build: item.build, contribution, kind, message });
      if (contribution !== null) {
        const key = JSON.stringify([item.plugin, item.build, contribution, kind]);
        if (counted.current.has(key)) return;
        counted.current.add(key);
      }
      if (!counter.hit(item.plugin, item.build)) return;
      disableForSession(item.plugin, item.build);
      report({
        plugin: item.plugin,
        build: item.build,
        contribution: null,
        kind: "budget",
        message: "the crash budget is spent: off for this browser session",
      });
      setRegistry((r) => ({ ...r, [item.plugin]: { status: "disabled" } }));
      toast.error(t("budget", { plugin: item.plugin }), {
        actionLabel: t("safeReload"),
        onAction: safeReload,
      });
    },
    [report, counter, toast, t, safeReload],
  );
  const failRef = useRef(fail);
  failRef.current = fail;

  // Load once per document (a Strict Mode remount does not import again).
  const started = useRef(false);
  useLayoutEffect(() => {
    if (started.current || !loaded) return;
    started.current = true;
    (globalThis as Record<string, unknown>)[HOST_GLOBAL] = {
      react: React,
      reactDom: ReactDOM,
      jsxRuntime: JsxRuntime,
      pluginClient: PLUGIN_CLIENT,
      design: HOST_DESIGN,
      apiVersion: CLIENT_API_VERSION,
    };
    const initial: ClientRegistry = {};
    const toLoad: ClientExtensionItem[] = [];
    for (const item of docItems) {
      if (isDisabledForSession(item.plugin, item.build))
        initial[item.plugin] = { status: "disabled" };
      else if (item.entry === null) initial[item.plugin] = { status: "ready" };
      else {
        initial[item.plugin] = { status: "loading" };
        toLoad.push(item);
      }
    }
    setRegistry(initial);
    const settle = (plugin: string, next: ClientRegistry[string]) =>
      setRegistry((r) => (r[plugin]?.status === "loading" ? { ...r, [plugin]: next } : r));
    for (const item of toLoad) {
      const url = item.entry?.url ?? "";
      loadWithTimeout(url).then(
        (mod) => {
          const { definition, problems } = validateEntry(mod, item, CLIENT_API_VERSION);
          if (definition === null) {
            settle(item.plugin, { status: "failed" });
            for (const p of problems) failRef.current(item, p.kind, p.contribution, p.message);
            return;
          }
          // A dropped component is reported, not counted: the rest of the plugin works.
          for (const p of problems) {
            report({
              plugin: item.plugin,
              build: item.build,
              contribution: p.contribution,
              kind: p.kind,
              message: p.message,
            });
          }
          settle(item.plugin, { status: "ready", definition });
        },
        (error: unknown) => {
          settle(item.plugin, { status: "failed" });
          failRef.current(item, "load", null, reportMessage(error));
        },
      );
    }
  }, [loaded, docItems, report]);

  // The plugins' `events` listeners, while each plugin is active.
  useEffect(() => {
    const offs: (() => void)[] = [];
    for (const [plugin, entry] of Object.entries(exposed)) {
      const events = entry.status === "ready" ? entry.definition?.events : undefined;
      const item = itemOf(plugin);
      if (events === undefined || item === undefined) continue;
      const api = clientApiFor(item, locale);
      offs.push(
        subscribeClientEvents(
          (e) => {
            const listener = events[e.type];
            if (typeof listener === "function") listener(e, api);
          },
          (error) => failRef.current(item, "event", null, reportMessage(error)),
        ),
      );
    }
    return () => {
      for (const off of offs) off();
    };
  }, [exposed, itemOf, locale]);

  // An uncaught error or rejection whose stack or file names a build's URL is that plugin's
  // (spec §10.3): reported as a `render` error of no contribution and counted.
  useEffect(() => {
    if (!loaded) return;
    const ownerOf = (text: string) =>
      docItems.find((i) =>
        text.includes(
          `/api/v1/client/${encodeURIComponent(i.plugin)}/${encodeURIComponent(i.build)}/`,
        ),
      );
    const blame = (where: string, error: unknown) => {
      const item = ownerOf(where);
      if (item === undefined || exposedRef.current[item.plugin]?.status !== "ready") return;
      failRef.current(item, "render", null, reportMessage(error));
    };
    const stackOf = (e: unknown) => (e instanceof Error ? (e.stack ?? "") : "");
    const onError = (e: ErrorEvent) =>
      blame(`${e.filename ?? ""}\n${stackOf(e.error)}`, e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => blame(stackOf(e.reason), e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [loaded, docItems]);

  // Only the stylesheets of active plugins of the document's set apply. React never removes a
  // hoisted sheet itself, and a later layout render (a `router.refresh()`) can hoist new ones: a
  // newly listed or upgraded build's sheet, or any sheet once the URL has lost `safe-ui=1`. So every
  // extension sheet in the head is policed, now and whenever one is added: in safe mode all are
  // disabled, otherwise every sheet that is not an active one of the document's set.
  const activeSheets = useMemo(() => {
    const hrefs = new Set<string>();
    for (const item of docItems) {
      const status = exposed[item.plugin]?.status;
      if (!listed.has(item.plugin) || status === "disabled") continue;
      if (status === undefined && isDisabledForSession(item.plugin, item.build)) continue;
      for (const s of item.styles) hrefs.add(s.url);
    }
    return [...hrefs].sort().join("\n");
  }, [docItems, exposed, listed]);
  useLayoutEffect(() => {
    const active = new Set(safe || leaving || activeSheets === "" ? [] : activeSheets.split("\n"));
    const police = () => {
      for (const link of document.querySelectorAll<HTMLLinkElement>(EXTENSION_SHEETS)) {
        const off = !active.has(link.getAttribute("href") ?? "");
        if (link.disabled !== off) link.disabled = off;
      }
    };
    police();
    const observer = new MutationObserver(police);
    observer.observe(document.head, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [activeSheets, safe, leaving]);

  // Client code the live read lists but the document's set lacks (a plugin turned on or applied,
  // a new build, the kill switch lifted) cannot load into this document (spec §9.6): a
  // non-blocking notice offers the reload, once per distinct addition. Not in safe mode.
  const added = useMemo(() => {
    if (safe || set?.enabled !== true) return "";
    const inDoc = new Set(docItems.map((i) => `${i.plugin}/${i.build}`));
    return set.items
      .filter(
        (i) => (i.entry !== null || i.styles.length > 0) && !inDoc.has(`${i.plugin}/${i.build}`),
      )
      .map((i) => `${i.plugin}/${i.build}`)
      .sort()
      .join("\n");
  }, [safe, set, docItems]);
  const notified = useRef("");
  useEffect(() => {
    if (added === "" || added === notified.current) return;
    notified.current = added;
    toast.success(t("changed"), { actionLabel: t("reload"), onAction: () => ClientHost.reload() });
  }, [added, toast, t]);

  const controls = useMemo<ClientHostControls>(
    () => ({
      item: itemOf,
      reportError: (plugin, contribution, kind, error) => {
        const item = itemOf(plugin);
        if (item === undefined || exposedRef.current[plugin]?.status === "disabled") return;
        failRef.current(item, kind, contribution, reportMessage(error));
      },
      subscribe: (plugin, contribution, handler) =>
        subscribeClientEvents(
          (e: CapybaraEvent) => {
            if (exposedRef.current[plugin]?.status === "ready") handler(e);
          },
          (error) => {
            const item = itemOf(plugin);
            if (item !== undefined)
              failRef.current(item, "event", contribution, reportMessage(error));
          },
        ),
    }),
    [itemOf],
  );

  const targetHasCode = useCallback(
    (key: ClientScopeKey) => {
      const q =
        key === "org"
          ? orgId === null
            ? null
            : clientExtensionsQuery(orgId)
          : key.startsWith("admin-p:")
            ? adminClientExtensionsQuery(key.slice("admin-p:".length))
            : null;
      if (q === null) return false;
      const cached = qc.getQueryData<ClientExtensionsResponse>(q.queryKey);
      return cached === undefined ? true : setHasCode(cached);
    },
    [qc, orgId],
  );
  const leave = useCallback(() => {
    // synchronously, before the navigation starts: the state update unmounts the components
    // before the next paint, the sheets go off now
    for (const link of document.querySelectorAll<HTMLLinkElement>(EXTENSION_SHEETS))
      link.disabled = true;
    setLeaving(true);
  }, []);
  useClientBoundary({ safe, loaded, targetHasCode, navigate, leave });

  const hostScope = useMemo(() => ({ scope, orgId }), [scope, orgId]);
  // Safe mode with client code: the banner, drawn by the frame as the App Shell's first row
  const banner = useMemo(
    () =>
      safe && setHasCode(set) ? (
        <SafeModeBanner
          onExit={() =>
            // `safe-ui=0`: the proxy clears the HttpOnly session cookie on this request
            navigate(withSafeUi(`${location.pathname}${location.search}${location.hash}`, false))
          }
        />
      ) : null,
    [safe, set, navigate],
  );
  return (
    <HostScopeProvider value={hostScope}>
      <ClientHostControlsProvider value={controls}>
        <ClientRegistryProvider value={exposed}>
          <ShellBannerProvider value={banner}>{children}</ShellBannerProvider>
        </ClientRegistryProvider>
      </ClientHostControlsProvider>
    </HostScopeProvider>
  );
}

/** Imports one entry, failing after {@link CLIENT_LOAD_TIMEOUT_MS}. */
function loadWithTimeout(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the entry did not load within ${CLIENT_LOAD_TIMEOUT_MS / 1000} s`)),
      CLIENT_LOAD_TIMEOUT_MS,
    );
    let p: Promise<unknown>;
    try {
      p = ClientHost.load(url);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (m) => {
        clearTimeout(timer);
        resolve(m);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The loader seam: a native dynamic import the bundler leaves alone (the URL is the kernel's,
 * resolved through the import map, verified by its `integrity`). Tests replace it.
 */
ClientHost.load = (url: string): Promise<unknown> =>
  import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);

/** The document reload seam (`location.reload`); tests replace it. */
ClientHost.reload = (): void => {
  window.location.reload();
};

/** The document navigation seam (`location.assign`); tests replace it. */
ClientHost.navigate = (href: string): void => {
  window.location.assign(href);
};

type ClientSource =
  | { kind: "org"; orgId: string }
  | { kind: "admin"; plugin: string }
  | { kind: "none"; orgId: string | null };

interface RootProps {
  source: ClientSource;
  safe: boolean;
  hostReady: boolean;
  children: ReactNode;
}

/**
 * The client host of the `(app)` layout: the set from the query cache (the layout read it with the
 * shell and hydrated it), so a later invalidation withdraws plugins from the open page. `none`:
 * a page that loads no client code (the admin console, no org); the boundary still holds. A
 * navigation to another source that may carry client code is a document load; one that does not
 * (a workspace document without client code entering the console) keeps this document, so the root
 * is one component whose query follows the source: a later layout render never remounts the frame.
 */
export function ClientHostRoot({ source, safe, hostReady, children }: RootProps) {
  const q =
    source.kind === "org"
      ? clientExtensionsQuery(source.orgId)
      : source.kind === "admin"
        ? adminClientExtensionsQuery(source.plugin)
        : null;
  const data = useQuery({
    ...(q ?? clientExtensionsQuery("")),
    enabled: q !== null,
    retryOnMount: q === null ? false : retryOnMountOf(q.queryKey),
  }).data;
  return (
    <ClientHost
      set={q === null ? null : (data ?? null)}
      safe={safe}
      scope={source.kind === "admin" ? "admin" : "org"}
      orgId={source.kind === "admin" ? null : source.orgId}
      hostReady={hostReady}
    >
      {children}
    </ClientHost>
  );
}
