import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconButton } from "../controls/index";
import type { ConvMenuEntry } from "../conversation/menu";
import { ConvMenu } from "../conversation/menu";
import type { NavBadge } from "../display/nav-badge";
import { Tooltip } from "../display/tooltip";
import { Icon } from "../icons/icon";
import {
  NATIVE_NAV_LIMITS,
  type NativeNavHandle,
  type NativeSectionId,
  useHaptics,
} from "../native";
import { type CommandGroup, CommandPalette } from "../overlays/index";
import type { MenuItem } from "../overlays/menus";
import { popOverlaysThen } from "../overlays/use-overlay-history";
import { useDesignT } from "../provider";
import { DesktopOnlyNotice, type DesktopOnlyNoticeProps } from "../templates/desktop-only";
import { backTarget, FloatingBar, type FloatingLead, routeCommitted } from "./floating-bar";
import { type DrawerNavData, NavDrawer } from "./nav-drawer";
import { keyboardInset } from "./pointer";
import { SetupSteps } from "./setup-steps";
import { useShellEnvironment } from "./shell-environment";
import { type ShellPage, ShellPageContext } from "./shell-page";
import { COLLAPSE_SHORTCUT, Sidebar, type SidebarProps, useSidebarWidthMode } from "./sidebar";
import { useShortWindow, useSizeClass } from "./size-class";
import { StatusBar, type StatusBarProps, StatusBarSetterContext } from "./status-bar";
import { useTouch } from "./touch";
import { useHydrated } from "./use-media-query";

export type AppShellProps = {
  sidebar: Omit<
    SidebarProps,
    | "onOpenCommands"
    | "mode"
    | "collapsed"
    | "onCollapsedChange"
    | "drawerOpen"
    | "onDrawerOpenChange"
  >;
  /**
   * The chat-first compact shell's drawer (design spec §4.6, §6.53): with it a chat surface shows
   * the floating menu button (the badge is `menuBadge`), which opens the drawer.
   */
  drawer?: DrawerNavData;
  /**
   * The page is a chat surface (the home's new conversation, a conversation): on compact its
   * leading floating control is the menu button; every other page is pushed and shows back
   * (design spec §4.6). A move between two chat surfaces never slides.
   */
  chatSurface?: boolean;
  /** The route (`usePathname()`, without the locale): the drawer's current row, the slide key. */
  pathname?: string;
  /**
   * A native shell's strip (`nav@1`, mobile app spec §6.1): the shell element and `<html>` carry
   * `data-native-nav`, which hides the web's own section entries and menu button; the shell tells
   * the strip the drawer's sections with the inbox count, the current one and (while compact) the
   * menu button, and follows its taps. The handle may be a new object on every render: only its
   * presence keys what is sent, so an equivalent handle sends nothing.
   */
  nativeNav?: NativeNavHandle;
  /**
   * Client navigation (apps/web: the router's push): the drawer's picks and the strip's taps.
   * `transition: "none"`: the move swaps at once (a native tab switch never slides).
   */
  onNavigate?(href: string, options?: { transition?: "none" }): void;
  /**
   * The compact floating row's trailing overflow menu for pages that do not register their own
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
   * The command palette's groups (⌘K, the sidebar's and the compact drawer's search). Without them
   * there is no palette and no search (the setup frame, T13).
   */
  commands?: CommandGroup[];
  status: Pick<StatusBarProps, "context" | "version" | "timeZone" | "system">;
  /** Draw the shell as the rail of the medium class whatever the window width (reference set only). */
  reference?: { rail: true };
  /**
   * The page draws its own status bar (the conversation page: under its middle column only, so a
   * full-height right panel sits beside it); the shell then draws none.
   */
  ownStatusBar?: boolean;
  /**
   * The route is a management page that is desktop-only on touch (mobile touch plan Task 29): the
   * shell draws the notice beside the page, the touch query shows one of them, and after hydration
   * only the one that applies is mounted (so the page's queries never run on touch). Presentation
   * only: the kernel decides access.
   */
  desktopOnly?: DesktopOnlyNoticeProps;
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
 * The App Shell (spec §4): Sidebar | content column. The content column holds the page (a
 * template, with its ActionRow at its bottom) and the StatusBar; on compact the floating row
 * (menu or back, §4.6) lies over the page's top and the drawer opens from the menu button. ⌘K
 * opens the command palette.
 */
export function AppShell({
  sidebar,
  drawer,
  chatSurface,
  pathname,
  nativeNav,
  onNavigate,
  menu,
  collapsed: collapsedProp,
  onCollapsedChange,
  commands,
  status,
  reference,
  ownStatusBar,
  capState,
  banner,
  singleScheme,
  desktopOnly,
  children,
}: AppShellProps) {
  const t = useDesignT();
  const mainId = `cb-main-${useId().replace(/[^\w-]/g, "")}`;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const railRef = reference !== undefined && "rail" in reference;
  const [pageStatus, setPageStatus] = useState<ReactNode>(null);
  const hydrated = useHydrated();
  const touch = useTouch();
  const sizeClass = useSizeClass();
  const short = useShortWindow();
  // Inside a native shell (mobile layout spec §9.3): its kind, after hydration; null in a browser.
  const shellKind = useShellEnvironment(singleScheme === true);
  // The medium rail's drawer (the full sidebar over the content): its toggle sits in the rail, or
  // in the desktop's top band (below); it never changes the collapsed choice.
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
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

  // What the page tells the shell about itself (name, path, overflow menu): the floating row's.
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
      if (p.actions !== undefined) merged.actions = p.actions;
      if (p.titleAway !== undefined) merged.titleAway = p.titleAway;
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
  // The route (spec §4.6): a chat surface shows the menu button, every other page is pushed and
  // shows back, which goes to the previous in-app entry while one lies behind, else up the path.
  // An open list-detail item or right area is a pushed page too, keyed by its URL state (§6.47).
  const surface = chatSurface === true;
  const pushedPage = !surface || page.onBack !== undefined;
  // What the slide compares: chat surfaces are one level.
  const root = surface;
  // How many in-app history entries lie behind this one: the Navigation API's current index minus
  // the index when the shell mounted, so a replace (router.replace at the start) adds none and a
  // forward is no pop. Without the API there is no count: a counter cannot tell a push from a
  // replace, so back goes up the path rather than risk leaving the app.
  // Read in render as an external store: Next's router moves the history inside an insertion
  // effect, where `currententrychange` fires synchronously, so the subscription only tells React
  // after that phase (`subscribeNavigation`) and a render always reads the current index.
  const [startIndex] = useState(() => navigationApi()?.currentEntry?.index ?? 0);
  const depth = useSyncExternalStore(
    subscribeNavigation,
    () => {
      const nav = navigationApi();
      return nav === null ? 0 : Math.max(0, (nav.currentEntry?.index ?? startIndex) - startIndex);
    },
    () => 0,
  );
  // The slide of the last route change: its direction and a parity that restarts the animation
  // when two pushes follow each other (the CSS animations are named by both).
  const [slide, setSlide] = useState<{ direction: "push" | "pop"; n: number } | null>(null);
  const lastRoute = useRef({ pathname, root });
  // A history move the browser animated itself (a back swipe: `hasUAVisualTransition`, mobile app
  // spec §4.4), keyed by the URL it landed on: the route change it causes swaps at once, so the
  // page never animates twice. A later navigation changes the URL, so a gesture that changed no
  // route never swallows the next slide.
  const uaTransition = useRef<string | null>(null);
  // The path a native strip tap went to (`transition: "none"`): its route change swaps at once.
  const instantRoute = useRef<string | null>(null);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const animated = (e as PopStateEvent & { hasUAVisualTransition?: boolean })
        .hasUAVisualTransition;
      uaTransition.current = animated === true ? window.location.href : null;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // The new route is in the DOM: a floating back waiting for it settles (its view transition then
  // captures the new page; `goBack` in floating-bar.tsx).
  useLayoutEffect(() => {
    routeCommitted(pathname);
  }, [pathname]);
  useEffect(() => {
    const last = lastRoute.current;
    if (last.pathname === pathname) return;
    lastRoute.current = { pathname, root };
    // A view transition already animates this move (the back button: `data-cb-transition` on
    // `<html>`, view-transition.ts): a CSS slide as well would run again once it ends, when the
    // `animation: none` that holds it during the transition lifts (the page slid in twice).
    const animated =
      uaTransition.current === window.location.href ||
      instantRoute.current === pathname ||
      document.documentElement.dataset.cbTransition !== undefined;
    uaTransition.current = null;
    instantRoute.current = null;
    // A pushed page slides in from the end edge and the way back to a chat surface slides back; a
    // move between chat surfaces and a move already animated (by the browser or a view
    // transition) do not.
    setSlide((prev) =>
      animated || (root && last.root)
        ? null
        : { direction: root ? "pop" : "push", n: ((prev?.n ?? 0) + 1) % 2 },
    );
  }, [pathname, root]);

  // The native strip (mobile app spec §6.1): its state comes from the drawer's data and the route.
  const haptics = useHaptics();
  const hasNav = nativeNav !== undefined;
  const navState = drawer
    ? {
        items: [
          { id: "chats" as const, label: navLabel(t("shell.chats")) },
          ...drawer.sections.map((s) => ({
            id: s.id,
            label: navLabel(s.label),
            ...navBadge(s.badge),
          })),
        ],
        current: currentSection(pathname, surface, drawer),
        menu:
          hydrated && sizeClass === "compact"
            ? { label: navLabel(t("shell.menu")), ...navBadge(drawer.menuBadge) }
            : null,
      }
    : null;
  const navKey = navState === null ? null : JSON.stringify(navState);
  const navSent = useRef<string | null>(null);
  const navLatest = useRef({ nav: nativeNav, drawer, onNavigate, haptics, navState, pathname });
  navLatest.current = { nav: nativeNav, drawer, onNavigate, haptics, navState, pathname };
  // `nav.set` is the one capability call made from an effect: a state push, not confirming. Only
  // the handle's presence and the state key it: an equivalent new handle sends nothing.
  useEffect(() => {
    const { nav, navState: state } = navLatest.current;
    if (!hasNav) {
      navSent.current = null;
      return;
    }
    if (nav === undefined || state === null || navSent.current === navKey) return;
    navSent.current = navKey;
    try {
      nav.set(state);
    } catch {
      // the strip keeps its last state
    }
  }, [hasNav, navKey]);
  // `<html data-native-nav>` (set before the first paint by the environment script) also reaches
  // the drawer and the menus, which portal out of the shell element: set while the handle is
  // there, cleared once it goes (the strip went away), never touched before a handle was seen.
  const hadNav = useRef(false);
  useEffect(() => {
    if (reference !== undefined) return;
    const root = document.documentElement;
    if (hasNav) {
      hadNav.current = true;
      root.setAttribute("data-native-nav", "");
    } else if (hadNav.current) {
      hadNav.current = false;
      root.removeAttribute("data-native-nav");
    }
  }, [hasNav, reference]);
  // The strip's taps and its menu button: subscribed per handle (resubscribing sends no state).
  useEffect(() => {
    if (nativeNav === undefined) return;
    const offs: (() => void)[] = [];
    const listen = (subscribe: () => unknown) => {
      try {
        const off = subscribe();
        if (typeof off === "function") offs.push(off as () => void);
      } catch {
        // a shell that cannot subscribe: its taps do nothing
      }
    };
    listen(() =>
      nativeNav.onSelect((id) => {
        const { drawer: d, onNavigate: go, haptics: buzz, pathname: now } = navLatest.current;
        const href = d === undefined ? undefined : sectionHref(id, d);
        if (href === undefined) return;
        buzz("selection");
        // An open drawer or sheet closes first: on a touch window its history entries are popped
        // and the move runs once that landed (Task 28's pick rule), else it closes at once. A tap
        // on the section whose root is already shown moves nowhere.
        const move = () => {
          if (href === now) return;
          // a tab switch swaps at once (no slide)
          instantRoute.current = href;
          if (go) go(href, { transition: "none" });
          else window.location.assign(href);
        };
        const popped = popOverlaysThen(move);
        setDrawerOpen(false);
        if (!popped) move();
      }),
    );
    listen(() => nativeNav.onMenu(() => setDrawerOpen((open) => !open)));
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
  // ⌘K opens the palette; ⌘\ / Ctrl+\ collapses or expands the sidebar on the expanded class and
  // opens or closes the medium rail's drawer (maintainer decision 2026-11-22; the collapsed choice
  // stays); compact has no sidebar. A ref keeps one listener for the latest state.
  const collapseKey = useRef<(() => void) | null>(null);
  collapseKey.current =
    reference !== undefined
      ? null
      : sizeClass === "expanded"
        ? () => setCollapsed(!collapsed)
        : sizeClass === "medium"
          ? () => setSidebarDrawerOpen((open) => !open)
          : null;
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

  // The floating row's leading control (spec §4.6): the setup frame's steps (back while they are
  // open), back on a pushed page, else the menu button where there is a drawer.
  const back =
    setup !== null && stepsOpen
      ? closeSteps
      : (page.onBack ??
        (pushedPage && setup === null ? backTarget(page.path ?? [], depth > 0) : undefined));
  const lead: FloatingLead | undefined =
    back !== undefined
      ? { kind: "back", target: back }
      : setup !== null
        ? { kind: "steps", onOpen: openSteps }
        : drawer
          ? { kind: "menu", onOpen: () => setDrawerOpen(true), badge: drawer.menuBadge }
          : undefined;
  // The trailing "…" (responsive system spec §2.5): the page's menu, then the head's actions.
  const overflow = joinOverflow(
    page.menu ?? menu ?? [],
    headActionEntries(page.actions ?? [], (href) =>
      onNavigate ? onNavigate(href) : window.location.assign(href),
    ),
  );
  const titleAway = page.titleAway === true && page.title !== undefined;
  // The collapsed sidebar's expand button in the desktop's top row (desktop client spec §7.3):
  // drawn inside a desktop shell while the person has collapsed the sidebar on the expanded class
  // (the medium rail cannot expand); CSS shows it only where the window controls reach past the
  // rail, and hides the rail's own expand button then.
  const topRowToggle =
    shellKind === "desktop" && collapsed && reference === undefined && sizeClass === "expanded";
  // The medium rail's sidebar toggle in the same place (maintainer decision 2026-11-21): it opens
  // the full sidebar as a drawer below the band; CSS shows it where the rail drops below the band,
  // and hides the rail's own toggle then.
  const topRowDrawerToggle =
    shellKind === "desktop" && reference === undefined && sizeClass === "medium";

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
          data-surface={surface ? "chat" : "pushed"}
        >
          {/* The native shell's top band (spec mobile layout §9.3): a window drag region on the
              desktop, drawn only under `<html data-shell>` by CSS. */}
          <div className="cb-shell-band" aria-hidden="true" />
          {/* The first tab stop: past the sidebar to the page (m9); visible only when focused. */}
          <a className="cb-skip-link" href={`#${mainId}`}>
            {t("shell.skipToContent")}
          </a>
          {topRowToggle ? (
            <div className="cb-shell-rail-toggle">
              <Tooltip content={`${t("sidebar.expand")} ${COLLAPSE_SHORTCUT}`}>
                <IconButton
                  label={t("sidebar.expand")}
                  icon={<Icon name="panel-left" />}
                  part="top-row-expand-toggle"
                  onClick={() => setCollapsed(false)}
                />
              </Tooltip>
            </div>
          ) : topRowDrawerToggle ? (
            <div className="cb-shell-rail-toggle">
              <Tooltip content={`${t("sidebar.show")} ${COLLAPSE_SHORTCUT}`}>
                <IconButton
                  label={t("sidebar.show")}
                  icon={<Icon name="panel-left" />}
                  part="top-row-drawer-toggle"
                  aria-expanded={sidebarDrawerOpen}
                  aria-haspopup="dialog"
                  onClick={() => setSidebarDrawerOpen((open) => !open)}
                />
              </Tooltip>
            </div>
          ) : null}
          {banner ? (
            <div className="cb-shell-banner" data-part="shell-banner">
              {banner}
            </div>
          ) : null}
          <Sidebar
            {...sidebar}
            {...(nativeNav ? { nativeNav: true } : {})}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            drawerOpen={sidebarDrawerOpen}
            onDrawerOpenChange={setSidebarDrawerOpen}
            onOpenCommands={() => setPaletteOpen(true)}
            {...(railRef ? { mode: "rail" as const } : {})}
          />
          <div
            className="cb-shell-column"
            data-part="shell-content"
            data-title-away={titleAway ? "true" : undefined}
          >
            {/* Drawn always, shown below 600 by CSS: the server render is right at every width. */}
            <div className="cb-shell-float" data-part="floating-bar-slot">
              <FloatingBar
                lead={lead}
                title={titleAway ? page.title : undefined}
                trailing={
                  overflow.length > 0 ? (
                    <ConvMenu
                      label={t("shell.moreActions")}
                      align="end"
                      size="touch"
                      sideOffset={2}
                      entries={overflow}
                      trigger={
                        <IconButton
                          part="more"
                          label={t("shell.moreActions")}
                          icon={<Icon name="more-horizontal" />}
                        />
                      }
                    />
                  ) : null
                }
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
              ) : desktopOnly ? (
                // The server and the hydrating render draw both (CSS shows one under the touch
                // query); once the pointer is known only the one that applies is mounted.
                <>
                  {touch === false ? null : (
                    <div className="cb-desktop-only-notice" data-part="desktop-only-gate">
                      <DesktopOnlyNotice {...desktopOnly} />
                    </div>
                  )}
                  {touch === true ? null : <div className="cb-desktop-only-page">{children}</div>}
                </>
              ) : (
                children
              )}
            </main>
            {ownStatusBar ? null : <StatusBar {...status} pageStatus={pageStatus} />}
          </div>
        </div>
        {drawer ? (
          <NavDrawer
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            pathname={pathname}
            onNavigate={onNavigate}
            // The shell's own palette when it has one; the drawer closes first.
            data={searchable ? { ...drawer, onSearch: () => setPaletteOpen(true) } : drawer}
          />
        ) : null}
        {commands ? (
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={commands} />
        ) : null}
      </StatusBarSetterContext.Provider>
    </ShellPageContext.Provider>
  );
}

/** The browser's Navigation API where it has one (not in every engine, and not in jsdom). */
type NavigationApi = {
  currentEntry: { index: number } | null;
  addEventListener(type: "currententrychange", fn: () => void): void;
  removeEventListener(type: "currententrychange", fn: () => void): void;
};
function navigationApi(): NavigationApi | null {
  if (typeof window === "undefined") return null; // the server render: read during render now
  const nav = (window as { navigation?: NavigationApi }).navigation;
  return nav?.currentEntry ? nav : null;
}

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/** A label within the strip's bound (`navLabel`), cut by code point. */
function navLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length > NATIVE_NAV_LIMITS.label
    ? chars.slice(0, NATIVE_NAV_LIMITS.label).join("")
    : label;
}

/** A badge in the strip's shape: a count within `navCount`, `countMore` past it; none at 0. */
function navBadge(badge: NavBadge | undefined): { count?: number; countMore?: boolean } {
  const n = badge?.count ?? 0;
  if (!(n > 0)) return {};
  const count = Math.min(Math.floor(n), NATIVE_NAV_LIMITS.count);
  const more = badge?.more === true || n > NATIVE_NAV_LIMITS.count;
  return { count, ...(more ? { countMore: true } : {}) };
}

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

/**
 * Subscribes to the Navigation API's entry changes, telling React in a microtask: the event fires
 * synchronously inside `history.pushState`, which Next's router calls from an insertion effect,
 * and an insertion effect must not schedule updates.
 */
function subscribeNavigation(onChange: () => void): () => void {
  const nav = navigationApi();
  if (nav === null) return () => {};
  const notify = () => queueMicrotask(onChange);
  nav.addEventListener("currententrychange", notify);
  return () => nav.removeEventListener("currententrychange", notify);
}

/** Two runs of overflow entries, a separator between them when both have any. */
function joinOverflow(menu: ConvMenuEntry[], actions: ConvMenuEntry[]): ConvMenuEntry[] {
  if (menu.length === 0) return actions;
  if (actions.length === 0) return menu;
  return [...menu, { kind: "separator" }, ...actions];
}

/**
 * The head's secondary actions as the floating row's overflow entries (responsive system spec
 * §2.5): a link calls `go(href)` after its own `onSelect`; a submenu becomes a labelled run of its
 * items. Separators at either end or doubled are dropped.
 */
function headActionEntries(
  items: readonly MenuItem[],
  go: (href: string) => void,
): ConvMenuEntry[] {
  const out: ConvMenuEntry[] = [];
  const walk = (list: readonly MenuItem[], prefix: string) => {
    list.forEach((item, i) => {
      if (item === "separator") {
        if (out.length > 0 && out[out.length - 1]?.kind !== "separator") {
          out.push({ kind: "separator" });
        }
        return;
      }
      if (item.submenu) {
        out.push({ kind: "label", label: item.label });
        walk(item.submenu, `${prefix}${i}-`);
        return;
      }
      const { href, onSelect } = item;
      out.push({
        kind: "item",
        id: `head-action-${prefix}${i}`,
        label: item.label,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.checked !== undefined ? { checked: item.checked } : {}),
        ...(item.danger ? { tone: "fail" as const } : {}),
        ...(item.disabled ? { disabled: true } : {}),
        onSelect: () => {
          onSelect?.();
          if (href !== undefined) go(href);
        },
      });
    });
  };
  walk(items, "");
  while (out[out.length - 1]?.kind === "separator") out.pop();
  return out;
}
