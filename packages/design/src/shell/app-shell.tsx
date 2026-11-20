import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ConvMenuEntry } from "../conversation/menu";
import { type NativeNavHandle, type NativeTabId, useHaptics } from "../native";
import { type CommandGroup, CommandPalette } from "../overlays/index";
import { useDesignT } from "../provider";
import { BottomNav, type BottomNavItem, bottomNavCurrent, isTabRoot } from "./bottom-nav";
import { keyboardInset } from "./pointer";
import { SetupSteps } from "./setup-steps";
import { useShellEnvironment } from "./shell-environment";
import { type ShellPage, ShellPageContext } from "./shell-page";
import { Sidebar, type SidebarProps, useSidebarWidthMode } from "./sidebar";
import { useShortWindow, useSizeClass } from "./size-class";
import { StatusBar, type StatusBarProps, StatusBarSetterContext } from "./status-bar";
import { backTarget, TopBar } from "./top-bar";
import { useHydrated } from "./use-media-query";

export type AppShellProps = {
  sidebar: Omit<SidebarProps, "onOpenCommands" | "mode" | "collapsed" | "onCollapsedChange">;
  /**
   * The compact class's four navigation items (design spec §6.45), from the same `useNav` data the
   * sidebar takes; drawn on tab roots only. Without them the compact shell has no bottom
   * navigation (the setup frame, the catalog).
   */
  bottomNav?: BottomNavItem[];
  /**
   * The route (`usePathname()`, without the locale): a route that is the target of a bottom
   * navigation item is a tab root, every other route is pushed (design spec §4.6); the item
   * whose root or pushed pages hold it is current.
   */
  pathname?: string;
  /**
   * A native shell's tab bar (`nav@1`, mobile app spec §6.1), in place of the web's bottom
   * navigation: the shell element carries `data-native-nav` (CSS drops the web's bar), the shell
   * tells the handle the four items, the current one and `visible` (exactly when the web would
   * have shown its own bar: compact, a tab root, no open keyboard) on every change, and a tap on a
   * native tab plays the `selection` haptic and navigates to the item's `href` with `onNavigate`.
   * The handle need not be stable: a new equivalent object per render sends no extra state (the
   * latest one receives the next change); unmounting the shell hides the bar.
   */
  nativeNav?: NativeNavHandle;
  /** Client navigation for the native tab bar (apps/web: the router's push). */
  onNavigate?(href: string): void;
  /**
   * The compact top bar's overflow menu for pages that do not register their own
   * ({@link useRegisterShellPage}); empty or absent: no button.
   */
  menu?: ConvMenuEntry[];
  /**
   * The person's choice of the rail on the expanded class (the `cb-sidebar` cookie, spec §4.1).
   * Controlled with `onCollapsedChange`; without `collapsed` the shell keeps its own state.
   */
  collapsed?: boolean;
  onCollapsedChange?(collapsed: boolean): void;
  /**
   * The command palette's groups (⌘K, the sidebar's and the compact top bar's search). Without them
   * there is no palette and no search (the setup frame, T13).
   */
  commands?: CommandGroup[];
  status: Pick<StatusBarProps, "context" | "version" | "timeZone" | "system">;
  /**
   * The compact top bar's title for a page that has not registered its name yet (the PageHeader
   * registers the h1 text); a tab root shows its item's label first.
   */
  title?: string;
  /** Draw the shell as the rail of the medium class whatever the window width (reference set only). */
  reference?: { rail: true };
  /**
   * The page draws its own status bar (the conversation page: under its middle column only, so a
   * full-height right panel sits beside it); the shell then draws none.
   */
  ownStatusBar?: boolean;
  /**
   * The state tokens for plugin CSS (`run=idle`, `motion=full`, `theme=builtin`, space-separated),
   * rendered as `data-cap-state` on the shell element. The shell appends its own `sidebar=rail`
   * or `sidebar=full` after hydration (none below 600: the compact class has no sidebar), then
   * `size=compact|medium|expanded`, then `shell=desktop|mobile` inside a native shell only.
   */
  capState?: string;
  /**
   * A shell-wide notice row (safe mode's `SafeModeBanner`): the shell's first row, across the
   * sidebar and the content column, which share the rest of the window. The shell keeps its
   * window height, so the status bar and the page's bottom stay visible.
   */
  banner?: ReactNode;
  /**
   * The resolved UI theme has a single scheme (no light / dark toggle): a native shell's
   * `chrome@1.setAppearance` is told so, and its own pages then use the reported colors only.
   */
  singleScheme?: boolean;
  children?: ReactNode;
};

/**
 * The App Shell (spec §4): Sidebar | content column. The content column holds, top to bottom,
 * the top bar (compact only), the page (a template, with its ActionRow at its bottom), the
 * StatusBar and the bottom navigation (compact tab roots only). ⌘K opens the command palette.
 */
export function AppShell({
  sidebar,
  bottomNav,
  pathname,
  nativeNav,
  onNavigate,
  menu,
  collapsed: collapsedProp,
  onCollapsedChange,
  commands,
  status,
  title,
  reference,
  ownStatusBar,
  capState,
  banner,
  singleScheme,
  children,
}: AppShellProps) {
  const t = useDesignT();
  const mainId = `cb-main-${useId().replace(/[^\w-]/g, "")}`;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const railRef = reference !== undefined && "rail" in reference;
  const [pageStatus, setPageStatus] = useState<ReactNode>(null);
  const hydrated = useHydrated();
  const sizeClass = useSizeClass();
  const short = useShortWindow();
  // Inside a native shell (mobile layout spec §9.3): its kind, after hydration; null in a browser.
  const shellKind = useShellEnvironment(singleScheme === true);
  const [ownCollapsed, setOwnCollapsed] = useState(false);
  const collapsed = collapsedProp ?? ownCollapsed;
  const setCollapsed = (next: boolean) => {
    if (collapsedProp === undefined) setOwnCollapsed(next);
    onCollapsedChange?.(next);
  };
  // the sidebar's mode by size class (one place: sidebar.tsx)
  const widthMode = useSidebarWidthMode(collapsed);
  const railWidth = widthMode === "rail";
  // Public mirror of the sidebar's mode (`data-mode` is internal); none before hydration, when
  // both panels are drawn and CSS picks one, and none on compact, which has no sidebar.
  const sidebarMode = !hydrated
    ? null
    : railRef || (reference === undefined && railWidth)
      ? "rail"
      : reference === undefined && widthMode === "none"
        ? null
        : "full";
  const stateTokens = !hydrated
    ? capState
    : [
        capState,
        sidebarMode === null ? null : `sidebar=${sidebarMode}`,
        sizeClass && `size=${sizeClass}`,
        shellKind && `shell=${shellKind}`,
      ]
        .filter(Boolean)
        .join(" ");

  // What the page tells the shell about itself (name, path, overflow menu): the compact top bar's.
  const [pages, setPages] = useState<ReadonlyMap<symbol, { page: ShellPage; layer: number }>>(
    () => new Map(),
  );
  const registerPage = useCallback((id: symbol, page: ShellPage | null, layer = 0) => {
    setPages((prev) => {
      const next = new Map(prev);
      if (page === null) next.delete(id);
      else next.set(id, { page, layer });
      return next;
    });
  }, []);
  const page = useMemo(() => {
    const merged: ShellPage = {};
    // later registrations win within a layer, a higher layer over a lower one (a stable sort)
    for (const { page: p } of [...pages.values()].sort((a, b) => a.layer - b.layer)) {
      if (p.title !== undefined) merged.title = p.title;
      if (p.path !== undefined) merged.path = p.path;
      if (p.menu !== undefined) merged.menu = p.menu;
      if (p.onBack !== undefined) merged.onBack = p.onBack;
    }
    return merged;
  }, [pages]);

  // The setup frame's steps are a page of their own on compact (spec §5.5): the setup home is the
  // tab root, the steps button pushes them (the URL hash `#steps`, so the system back closes them).
  const setup = sidebar.context.kind === "setup" ? sidebar.context : null;
  const inSetup = setup !== null;
  const [stepsOpen, setStepsOpen] = useState(false);
  // Whether the steps button pushed the `#steps` entry (closing steps back out of it), reset once
  // the steps page is left any other way (the system back, a link)
  const stepsPushed = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` re-reads the hash after a link left the steps page (a client navigation fires no hashchange)
  useEffect(() => {
    if (!inSetup) return;
    const read = () => {
      const open = window.location.hash === "#steps";
      if (!open) stepsPushed.current = false;
      setStepsOpen(open);
    };
    read();
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, [inSetup, pathname]);
  // The route: a tab root shows the bottom navigation, every other route is pushed (spec §4.6).
  // Back goes to the previous in-app entry while one lies behind, else up the path.
  const items = bottomNav ?? [];
  const tabRoot = pathname === undefined || items.length === 0 || isTabRoot(items, pathname);
  // An open list-detail item is a pushed page too, keyed by its URL state (spec §4.6, §6.47).
  const pushed = !tabRoot || page.onBack !== undefined || (setup !== null && stepsOpen);
  const currentTab = pathname === undefined ? null : bottomNavCurrent(items, pathname);
  // How many in-app history entries lie behind this one: the Navigation API's current index minus
  // the index when the shell mounted, so a replace (router.replace at the start) adds none and a
  // forward is no pop. Without the API there is no count: a counter cannot tell a push from a
  // replace, so back goes up the path rather than risk leaving the app.
  const [depth, setDepth] = useState(0);
  useEffect(() => {
    const nav = navigationApi();
    if (nav === null) return;
    const start = nav.currentEntry?.index ?? 0;
    const update = () => setDepth(Math.max(0, (nav.currentEntry?.index ?? start) - start));
    nav.addEventListener("currententrychange", update);
    return () => nav.removeEventListener("currententrychange", update);
  }, []);
  // The slide of the last route change: its direction and a parity that restarts the animation
  // when two pushes follow each other (the CSS animations are named by both).
  const [slide, setSlide] = useState<{ direction: "push" | "pop"; n: number } | null>(null);
  const lastRoute = useRef({ pathname, tabRoot });
  // A history move the browser animated itself (a back swipe: `hasUAVisualTransition`, mobile app
  // spec §4.4), keyed by the URL it landed on: the route change it causes swaps at once, so the
  // page never animates twice. A later navigation changes the URL, so a gesture that changed no
  // route never swallows the next slide.
  const uaTransition = useRef<string | null>(null);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const animated = (e as PopStateEvent & { hasUAVisualTransition?: boolean })
        .hasUAVisualTransition;
      uaTransition.current = animated === true ? window.location.href : null;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    const last = lastRoute.current;
    if (last.pathname === pathname) return;
    lastRoute.current = { pathname, tabRoot };
    const animated = uaTransition.current === window.location.href;
    uaTransition.current = null;
    // A pushed page slides in from the end edge and the way back to a root slides back; a move
    // between tab roots (the web's or the native tab bar) and a move the browser animated do not.
    setSlide((prev) =>
      animated || (tabRoot && last.tabRoot)
        ? null
        : { direction: tabRoot ? "pop" : "push", n: ((prev?.n ?? 0) + 1) % 2 },
    );
  }, [pathname, tabRoot]);
  const tabLabel = items.find((i) => i.id === currentTab && tabRoot)?.label;

  // The native tab bar (mobile app spec §6.1): visible exactly when the web would show its own
  // bar (the slot below, and the CSS that shows it on compact while no keyboard is open).
  // The handle may be a new object on every render (a parent building it inline): only its
  // presence keys the state and hide effects, which reach the latest handle through a ref, so an
  // equivalent new handle sends nothing and never hides and shows the bar. Only the tap
  // subscription follows the handle itself (resubscribing sends no state).
  const haptics = useHaptics();
  const hasNav = nativeNav !== undefined;
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const el = shellRef.current;
    if (!hasNav || el === null || typeof MutationObserver === "undefined") return;
    const read = () => setKeyboardOpen(el.dataset.keyboard === "open");
    read();
    const observer = new MutationObserver(read);
    observer.observe(el, { attributes: true, attributeFilter: ["data-keyboard"] });
    return () => observer.disconnect();
  }, [hasNav]);
  const navState = {
    items: items.map(nativeTab),
    current: currentTab,
    visible: hydrated && sizeClass === "compact" && items.length > 0 && !pushed && !keyboardOpen,
  };
  const navKey = JSON.stringify(navState);
  const navSent = useRef<string | null>(null);
  const navLatest = useRef({ nav: nativeNav, items, onNavigate, haptics, navState });
  navLatest.current = { nav: nativeNav, items, onNavigate, haptics, navState };
  // The last handle the shell had: the hide below reaches it after `nativeNav` went undefined
  // while the shell stays mounted (`navLatest` then holds no handle).
  const navHandle = useRef(nativeNav);
  if (nativeNav !== undefined) navHandle.current = nativeNav;
  // the page without this shell (an auth page) has no tab bar: hidden once the shell or its handle
  // goes
  useEffect(() => {
    if (!hasNav) return;
    return () => {
      const { navState: last } = navLatest.current;
      try {
        navHandle.current?.set({ ...last, visible: false });
      } catch {
        // the shell keeps its last state
      }
      navSent.current = null;
    };
  }, [hasNav]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `navKey` is `navState`, deduped
  useEffect(() => {
    const { nav, navState: state } = navLatest.current;
    if (!hasNav || nav === undefined || navSent.current === navKey) return;
    navSent.current = navKey;
    try {
      nav.set(state);
    } catch {
      // the shell keeps its last state
    }
  }, [hasNav, navKey]);
  useEffect(() => {
    if (nativeNav === undefined) return;
    let off: (() => void) | undefined;
    try {
      const r = nativeNav.onSelect((id) => {
        const { items: now, onNavigate: go, haptics: buzz } = navLatest.current;
        const item = now.find((i) => i.id === id);
        if (item === undefined) return;
        buzz("selection");
        if (go) go(item.href);
        else window.location.assign(item.href);
      });
      if (typeof r === "function") off = r;
    } catch {
      // a shell that cannot subscribe: its taps do nothing
    }
    return () => {
      try {
        off?.();
      } catch {
        // already gone
      }
    };
  }, [nativeNav]);

  const openSteps = useCallback(() => {
    stepsPushed.current = true;
    window.history.pushState(window.history.state, "", "#steps");
    setStepsOpen(true);
  }, []);
  const closeSteps = useCallback(() => {
    // `#steps` was pushed by the button: its entry goes; a deep link to it just drops the hash
    if (stepsPushed.current) {
      stepsPushed.current = false;
      window.history.back();
    } else {
      window.history.replaceState(window.history.state, "", window.location.pathname);
      setStepsOpen(false);
    }
  }, []);

  const searchable = commands !== undefined;
  // ⌘K opens the palette; ⌘\ / Ctrl+\ collapses or expands the sidebar (the expanded class only:
  // medium has the rail alone, compact no sidebar). A ref keeps one listener for the latest state.
  const collapseKey = useRef<(() => void) | null>(null);
  collapseKey.current =
    sizeClass === "expanded" && reference === undefined ? () => setCollapsed(!collapsed) : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (searchable && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "\\" && collapseKey.current) {
        e.preventDefault();
        collapseKey.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchable]);

  // iOS (Safari and the WebKit Chrome) scrolls the document to show a focused text field even though
  // the shell never lets it scroll, and does not always scroll back when the keyboard closes: the
  // head then sits under the status bar and cannot be tapped. Once the keyboard is closed (the visual
  // viewport is the full window again; without visualViewport: no text field focused), put the
  // document back at the top.
  // iOS also keeps the layout viewport when the keyboard opens, so a composer pinned at the bottom
  // sat behind it (spec §4.3): the keyboard's height over the shell's bottom is the shell's
  // `--cb-keyboard-inset` (with `data-keyboard="open"`), which the conversation page lifts its
  // column by. While the keyboard is open the document is not scrolled; the inset does the work.
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reference !== undefined) return;
    const vv = window.visualViewport;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (vv) {
          const shell = shellRef.current;
          const rect = shell?.getBoundingClientRect();
          const inset = keyboardInset(
            vv,
            rect && rect.height > 0 ? rect.bottom : window.innerHeight,
          );
          if (shell) {
            shell.style.setProperty("--cb-keyboard-inset", `${inset}px`);
            if (inset > 0) shell.dataset.keyboard = "open";
            else delete shell.dataset.keyboard;
          }
          if (vv.height < window.innerHeight - 120) return;
        } else {
          const active = document.activeElement;
          if (
            active instanceof HTMLElement &&
            (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
          )
            return;
        }
        if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
      });
    };
    document.addEventListener("focusout", update);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusout", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, [reference]);

  return (
    <ShellPageContext.Provider value={registerPage}>
      <StatusBarSetterContext.Provider value={setPageStatus}>
        <div
          ref={shellRef}
          className="cb-shell"
          data-cap-part="shell"
          data-cap-state={stateTokens}
          data-banner={banner ? "true" : undefined}
          data-short={short ? "true" : undefined}
          data-native-nav={nativeNav ? "" : undefined}
        >
          {/* The native shell's top band (spec mobile layout §9.3): a window drag region on the
              desktop, drawn only under `<html data-shell>` by CSS. */}
          <div className="cb-shell-band" aria-hidden="true" />
          {/* The first tab stop: past the sidebar to the page (m9); visible only when focused. */}
          <a className="cb-skip-link" href={`#${mainId}`}>
            {t("shell.skipToContent")}
          </a>
          {banner ? (
            <div className="cb-shell-banner" data-part="shell-banner">
              {banner}
            </div>
          ) : null}
          <Sidebar
            {...sidebar}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            onOpenCommands={() => setPaletteOpen(true)}
            {...(railRef ? { mode: "rail" as const } : {})}
          />
          <div className="cb-shell-column" data-part="shell-content">
            {/* Drawn always, shown below 600 by CSS: the server render is right at every width. */}
            <div className="cb-shell-topbar" data-part="top-bar-slot">
              <TopBar
                title={page.title ?? tabLabel ?? title}
                back={
                  setup !== null && stepsOpen
                    ? closeSteps
                    : (page.onBack ?? (pushed ? backTarget(page.path ?? [], depth > 0) : undefined))
                }
                onSearch={searchable ? () => setPaletteOpen(true) : undefined}
                menu={page.menu ?? menu}
                onSteps={setup !== null ? openSteps : undefined}
              />
            </div>
            <main
              className="cb-shell-main"
              id={mainId}
              tabIndex={-1}
              // The slide of the last push or pop (compact only, none under reduced motion).
              data-nav={slide ? `${slide.direction}-${slide.n}` : undefined}
            >
              {setup !== null ? (
                <>
                  <div className="cb-setup-body" data-steps-open={stepsOpen ? "true" : "false"}>
                    {children}
                  </div>
                  {stepsOpen ? (
                    <div className="cb-setup-steps-page" data-open="true">
                      <SetupSteps
                        home={setup.home}
                        steps={setup.steps}
                        current={sidebar.activeNav}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                children
              )}
            </main>
            {ownStatusBar ? null : <StatusBar {...status} pageStatus={pageStatus} />}
            {items.length > 0 && !pushed ? (
              <div className="cb-shell-bottomnav" data-part="bottom-nav-slot">
                <BottomNav items={items} current={currentTab} />
              </div>
            ) : null}
          </div>
        </div>
        {commands ? (
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={commands} />
        ) : null}
      </StatusBarSetterContext.Provider>
    </ShellPageContext.Provider>
  );
}

/** The largest count the native tab bar takes (`nav@1`); more is that count, truncated. */
const MAX_NATIVE_COUNT = 9999;
/** The longest label the native tab bar takes (`nav@1`). */
const MAX_NATIVE_LABEL = 32;

/** A bottom navigation item as the native tab bar takes it: within its limits. */
function nativeTab(item: BottomNavItem): {
  id: NativeTabId;
  label: string;
  count?: number;
  countMore?: boolean;
} {
  const tab: { id: NativeTabId; label: string; count?: number; countMore?: boolean } = {
    id: item.id,
    label: [...item.label].slice(0, MAX_NATIVE_LABEL).join(""),
  };
  if (item.count !== undefined && Number.isFinite(item.count)) {
    const count = Math.max(0, Math.min(MAX_NATIVE_COUNT, Math.floor(item.count)));
    tab.count = count;
    if (item.countMore || item.count > MAX_NATIVE_COUNT) tab.countMore = true;
  } else if (item.countMore) tab.countMore = true;
  return tab;
}

/** The browser's Navigation API where it has one (not in every engine, and not in jsdom). */
type NavigationApi = {
  currentEntry: { index: number } | null;
  addEventListener(type: "currententrychange", fn: () => void): void;
  removeEventListener(type: "currententrychange", fn: () => void): void;
};
function navigationApi(): NavigationApi | null {
  const nav = (window as { navigation?: NavigationApi }).navigation;
  return nav?.currentEntry ? nav : null;
}
