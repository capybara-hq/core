import { type ReactNode, useEffect, useState } from "react";
import { CommandPalette } from "../overlays/index";
import { StatusBar, type StatusBarProps, StatusBarSetterContext } from "./status-bar";
import { TopBar, type TopBarProps } from "./top-bar";

export function AppShell({
  topBar,
  status,
  children,
}: {
  topBar: TopBarProps;
  status: Pick<StatusBarProps, "context" | "version" | "system">;
  children?: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pageStatus, setPageStatus] = useState<ReactNode>(null);

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

  return (
    <StatusBarSetterContext.Provider value={setPageStatus}>
      <div className="cb-shell">
        <TopBar {...topBar} onOpenCommands={() => setPaletteOpen(true)} />
        <main className="cb-shell-main">{children}</main>
        <StatusBar {...status} pageStatus={pageStatus} />
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={topBar.commands} />
    </StatusBarSetterContext.Provider>
  );
}
