import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import { type CommandGroup, CommandPalette } from "../overlays/index";
import { useDesignT } from "../provider";
import { keyboardInset } from "./pointer";
import { Sidebar, type SidebarProps, useSidebarWidthMode } from "./sidebar";
import { StatusBar, type StatusBarProps, StatusBarSetterContext } from "./status-bar";
import { useHydrated } from "./use-media-query";

export type AppShellProps = {
  sidebar: Omit<SidebarProps, "onOpenCommands" | "mode" | "drawer" | "drawerInline">;
  /**
   * The command palette's groups (⌘K, the sidebar's and the drawer bar's search). Without them
   * there is no palette and no search (the setup frame, T13).
   */
  commands?: CommandGroup[];
  status: Pick<StatusBarProps, "context" | "version" | "timeZone" | "system">;
  /** The page title in the drawer menu bar (below 960); defaults to none. */
  title?: string;
  /**
   * Draw the shell as below 960 whatever the window width, with the drawer open in place (the
   * reference set and the catalog only).
   */
  reference?: { drawer: true } | { rail: true };
  /**
   * The page draws its own status bar (the conversation page: under its middle column only, so a
   * full-height right panel sits beside it); the shell then draws none.
   */
  ownStatusBar?: boolean;
  /**
   * The state tokens for plugin CSS (`run=idle`, `motion=full`, `theme=builtin`, space-separated),
   * rendered as `data-cap-state` on the shell element. The shell appends its own `sidebar=rail`
   * or `sidebar=full` after hydration (the drawer below 960 counts as `full`: it is the full
   * panel).
   */
  capState?: string;
  /**
   * A shell-wide notice row (safe mode's `SafeModeBanner`): the shell's first row, across the
   * sidebar and the content column, which share the rest of the window. The shell keeps its
   * window height, so the status bar and the page's bottom stay visible.
   */
  banner?: ReactNode;
  children?: ReactNode;
};

/**
 * The App Shell (spec §4): Sidebar | content column. The content column holds, top to bottom,
 * the drawer menu bar (below 960 only), the page (a template, with its ActionRow at its bottom)
 * and the StatusBar. ⌘K opens the command palette.
 */
export function AppShell({
  sidebar,
  commands,
  status,
  title,
  reference,
  ownStatusBar,
  capState,
  banner,
  children,
}: AppShellProps) {
  const t = useDesignT();
  const mainId = `cb-main-${useId().replace(/[^\w-]/g, "")}`;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const drawerRef = reference !== undefined && "drawer" in reference;
  const railRef = reference !== undefined && "rail" in reference;
  const [drawerOpen, setDrawerOpen] = useState(drawerRef);
  const [pageStatus, setPageStatus] = useState<ReactNode>(null);
  const hydrated = useHydrated();
  // the sidebar's own breakpoints (one place: sidebar.tsx)
  const widthMode = useSidebarWidthMode();
  const narrow = widthMode === "drawer";
  const railWidth = widthMode === "rail";
  // Public mirror of the sidebar's mode (`data-mode` is internal); none before hydration, when
  // both panels are drawn and CSS picks one.
  const sidebarMode = !hydrated
    ? null
    : railRef || (reference === undefined && railWidth)
      ? "rail"
      : "full";
  const stateTokens =
    sidebarMode === null
      ? capState
      : [capState, `sidebar=${sidebarMode}`].filter(Boolean).join(" ");

  const searchable = commands !== undefined;
  useEffect(() => {
    if (!searchable) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
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

  // Before hydration the bar is drawn and CSS shows it below 960 only.
  const bar = drawerRef || (!railRef && (!hydrated || narrow));

  return (
    <StatusBarSetterContext.Provider value={setPageStatus}>
      <div
        ref={shellRef}
        className="cb-shell"
        data-cap-part="shell"
        data-cap-state={stateTokens}
        data-banner={banner ? "true" : undefined}
      >
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
          onOpenCommands={() => setPaletteOpen(true)}
          // A drawn-in-place reference drawer stays open (Esc closes the topmost real overlay only).
          drawer={{ open: drawerOpen, onOpenChange: drawerRef ? () => {} : setDrawerOpen }}
          {...(drawerRef ? { mode: "drawer" as const, drawerInline: true } : {})}
          {...(railRef ? { mode: "rail" as const } : {})}
        />
        <div className="cb-shell-column" data-part="shell-content">
          {bar ? (
            <div
              className="cb-shell-drawerbar"
              data-part="drawer-bar"
              data-responsive={hydrated || reference ? undefined : "true"}
            >
              <IconButton
                label={t("sidebar.menu")}
                icon={<Icon name="menu" />}
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen(true)}
              />
              {title ? <span className="cb-shell-drawerbar-title">{title}</span> : null}
              {/* Search stays reachable by pointer below 960 (the drawer swaps it for close). */}
              {searchable ? (
                <span className="cb-shell-drawerbar-end">
                  <IconButton
                    label={`${t("shell.searchShort")} ⌘K`}
                    icon={<Icon name="search" />}
                    onClick={() => setPaletteOpen(true)}
                  />
                </span>
              ) : null}
            </div>
          ) : null}
          <main className="cb-shell-main" id={mainId} tabIndex={-1}>
            {children}
          </main>
          {ownStatusBar ? null : <StatusBar {...status} pageStatus={pageStatus} />}
        </div>
      </div>
      {commands ? (
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={commands} />
      ) : null}
    </StatusBarSetterContext.Provider>
  );
}
