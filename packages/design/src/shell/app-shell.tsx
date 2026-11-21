import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { IconButton } from "../controls/index";
import type { ConvMenuEntry } from "../conversation/menu";
import { ConvMenu } from "../conversation/menu";
import { Icon } from "../icons/icon";
import type { NativeNavHandle } from "../native";
import { type CommandGroup, CommandPalette } from "../overlays/index";
import { useDesignT } from "../provider";
import { backTarget, FloatingBar, type FloatingLead } from "./floating-bar";
import { type DrawerNavData, NavDrawer } from "./nav-drawer";
import { keyboardInset } from "./pointer";
import { SetupSteps } from "./setup-steps";
import { useShellEnvironment } from "./shell-environment";
import { type ShellPage, ShellPageContext } from "./shell-page";
import { Sidebar, type SidebarProps, useSidebarWidthMode } from "./sidebar";
import { useShortWindow, useSizeClass } from "./size-class";
import { StatusBar, type StatusBarProps, StatusBarSetterContext } from "./status-bar";
import { useHydrated } from "./use-media-query";

export type AppShellProps = {
  sidebar: Omit<SidebarProps, "onOpenCommands" | "mode" | "collapsed" | "onCollapsedChange">;
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
   * A native shell's navigation (`nav@1`): the shell element carries `data-native-nav`. Until the
   * strip rework (mobile touch plan Task 30) the shell sends it nothing: the chat-first shell has
   * no tab items to give it.
   */
  nativeNav?: NativeNavHandle;
  /** Client navigation (apps/web: the router's push): the drawer's picks. */
  onNavigate?(href: string): void;
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
  /**
   * The page's name for a page that has not registered one (the PageHeader registers the h1
   * text). The chat-first compact shell draws no title row of its own: the page's head carries it.
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
  children,
}: AppShellProps) {
  const t = useDesignT();
  const mainId = `cb-main-${useId().replace(/[^\w-]/g, "")}`;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
  const lastRoute = useRef({ pathname, root });
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
    lastRoute.current = { pathname, root };
    const animated = uaTransition.current === window.location.href;
    uaTransition.current = null;
    // A pushed page slides in from the end edge and the way back to a chat surface slides back; a
    // move between chat surfaces and a move the browser animated do not.
    setSlide((prev) =>
      animated || (root && last.root)
        ? null
        : { direction: root ? "pop" : "push", n: ((prev?.n ?? 0) + 1) % 2 },
    );
  }, [pathname, root]);

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
  const overflow = page.menu ?? menu ?? [];

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
            <div className="cb-shell-float" data-part="floating-bar-slot">
              <FloatingBar
                lead={lead}
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
  const nav = (window as { navigation?: NavigationApi }).navigation;
  return nav?.currentEntry ? nav : null;
}
