import { createContext, type ReactNode, useContext, useEffect } from "react";

export type StatusBarProps = {
  /** `user@org:route`; empty before the session loads (nothing is shown then). */
  context: string;
  version: string;
  /** Local time zone, such as `UTC+8`; shown after the version. */
  timeZone?: string;
  system?: ReactNode;
  pageStatus?: ReactNode;
  /**
   * The first `system` item is a page's run state: announced politely (`role="status"`), the
   * page's one live status (the conversation page; the thread itself announces messages).
   */
  announceFirst?: boolean;
};

const shown = (v: ReactNode) => v != null && v !== false && v !== "";

/**
 * The status bar (spec §4.4): read-only, inside the content area. Left: context · page status
 * (truncates first); right: system status, version, time zone, separated by spacing only (the
 * signed reference). No background, no prefix.
 */
export function StatusBar({
  context,
  version,
  timeZone,
  system,
  pageStatus,
  announceFirst,
}: StatusBarProps) {
  // `system` may be several items (the conversation page: run status, context usage).
  const right = [...(Array.isArray(system) ? system : [system]), version, timeZone].filter(shown);
  return (
    <footer className="cb-statusbar" data-part="status-bar">
      <span className="cb-statusbar-left">
        {context !== "" ? (
          <span className="cb-statusbar-context" data-part="status-bar-context" title={context}>
            {context}
          </span>
        ) : null}
        {shown(pageStatus) ? <span className="cb-statusbar-page">{pageStatus}</span> : null}
      </span>
      <span className="cb-statusbar-right" data-part="status-bar-right">
        {right.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots
          <span key={i} {...(announceFirst && i === 0 ? { role: "status" } : {})}>
            {v}
          </span>
        ))}
      </span>
    </footer>
  );
}

export const StatusBarSetterContext = createContext<((v: ReactNode) => void) | null>(null);

/** A page writes its "page status" into the StatusBar; cleared on unmount. */
export function useStatusBar(pageStatus: ReactNode): void {
  const set = useContext(StatusBarSetterContext);
  useEffect(() => {
    set?.(pageStatus);
    return () => set?.(null);
  }, [set, pageStatus]);
}
