import { createContext, type ReactNode, useContext, useEffect } from "react";

export type StatusBarProps = {
  context: string;
  version: string;
  system?: ReactNode;
  pageStatus?: ReactNode;
};

export function StatusBar({ context, version, system, pageStatus }: StatusBarProps) {
  return (
    <footer className="cb-statusbar">
      <span className="cb-statusbar-left">
        <span className="cb-statusbar-ctx">{`> ${context}`}</span>
        {pageStatus ? <span className="cb-statusbar-page">{pageStatus}</span> : null}
      </span>
      <span className="cb-statusbar-right">
        {system ? <span>{system}</span> : null}
        <span>{version}</span>
      </span>
    </footer>
  );
}

export const StatusBarSetterContext = createContext<((v: ReactNode) => void) | null>(null);

/** 页面把「页面状态」写入 StatusBar；卸载时清除。 */
export function useStatusBar(pageStatus: ReactNode): void {
  const set = useContext(StatusBarSetterContext);
  useEffect(() => {
    set?.(pageStatus);
    return () => set?.(null);
  }, [set, pageStatus]);
}
