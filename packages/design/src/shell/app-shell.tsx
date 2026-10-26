import { type ReactNode, useEffect, useState } from "react";
import { IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import { type CommandGroup, CommandPalette } from "../overlays/index";
import { useDesignT } from "../provider";
import { Sidebar, type SidebarProps } from "./sidebar";
import { StatusBar, type StatusBarProps, StatusBarSetterContext } from "./status-bar";
import { useHydrated, useMediaQuery } from "./use-media-query";

export type AppShellProps = {
  sidebar: Omit<SidebarProps, "onOpenCommands" | "mode" | "drawer" | "drawerInline">;
  commands: CommandGroup[];
  status: Pick<StatusBarProps, "context" | "version" | "timeZone" | "system">;
  /** The page title in the drawer menu bar (below 960); defaults to none. */
  title?: string;
  /**
   * Draw the shell as below 960 whatever the window width, with the drawer open in place (the
   * reference set and the catalog only).
   */
  reference?: { drawer: true };
  children?: ReactNode;
};

/**
 * The App Shell (spec §4): Sidebar | content column. The content column holds, top to bottom,
 * the drawer menu bar (below 960 only), the page (a template, with its ActionRow at its bottom)
 * and the StatusBar. ⌘K opens the command palette.
 */
export function AppShell({ sidebar, commands, status, title, reference, children }: AppShellProps) {
  const t = useDesignT();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(reference?.drawer === true);
  const [pageStatus, setPageStatus] = useState<ReactNode>(null);
  const hydrated = useHydrated();
  const narrow = useMediaQuery("(max-width: 959px)");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Before hydration the bar is drawn and CSS shows it below 960 only.
  const bar = reference?.drawer === true || !hydrated || narrow;

  return (
    <StatusBarSetterContext.Provider value={setPageStatus}>
      <div className="cb-shell">
        <Sidebar
          {...sidebar}
          onOpenCommands={() => setPaletteOpen(true)}
          // A drawn-in-place reference drawer stays open (Esc closes the topmost real overlay only).
          drawer={{ open: drawerOpen, onOpenChange: reference ? () => {} : setDrawerOpen }}
          {...(reference?.drawer ? { mode: "drawer" as const, drawerInline: true } : {})}
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
            </div>
          ) : null}
          <main className="cb-shell-main">{children}</main>
          <StatusBar {...status} pageStatus={pageStatus} />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={commands} />
    </StatusBarSetterContext.Provider>
  );
}
