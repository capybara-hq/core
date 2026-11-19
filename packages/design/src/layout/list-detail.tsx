import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export type ListDetailProps = {
  /** The list: the page itself in the stack form. */
  list: ReactNode;
  /** The open item; `null` = nothing open (the stack shows the list). */
  detail: ReactNode | null;
  /** The stack's back button (the shell's top bar draws its own where there is a shell). */
  onBack(): void;
  /** The list column's width and the detail's least width: both panes need `listMin + detailMin`. */
  listMin: number;
  detailMin: number;
  /** The region's name (an accessible name for the group). */
  label: string;
  /** What two panes show while `detail` is `null` (the template's default item, or a hint). */
  preview?: ReactNode;
};

export type ListDetailMode = "stack" | "two-pane";

const ModeContext = createContext<ListDetailMode>("stack");

/** The form the enclosing `ListDetail` draws, for a detail that differs between the forms. */
export function useListDetailMode(): ListDetailMode {
  return useContext(ModeContext);
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The one behavior of a list-detail region (spec §6.47): two panes while the region's own width
 * (a container measurement, so the sidebar, a rail and a second viewport segment count) fits
 * `listMin + detailMin`, else the two-level stack: the list is the page, an item is pushed in its
 * place with a back button, and back returns to the list at its scroll position. Before the
 * first measurement (the server render) the stack is drawn.
 */
export function ListDetail({
  list,
  detail,
  onBack,
  listMin,
  detailMin,
  label,
  preview,
}: ListDetailProps) {
  const t = useDesignT();
  const root = useRef<HTMLDivElement>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const scrolled = useRef(0);
  const [wide, setWide] = useState(false);
  const open = detail !== null;
  const hiddenList = !wide && open;

  useIsoLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setWide(el.clientWidth >= listMin + detailMin);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [listMin, detailMin]);

  // The list keeps its scroll position while an item covers it.
  useIsoLayoutEffect(() => {
    if (!hiddenList && listPane.current) listPane.current.scrollTop = scrolled.current;
  }, [hiddenList]);

  const mode: ListDetailMode = wide ? "two-pane" : "stack";
  const pane = wide ? (detail ?? preview ?? null) : detail;
  return (
    <ModeContext.Provider value={mode}>
      <section
        ref={root}
        className="cb-listdetail"
        data-part="list-detail"
        data-mode={mode}
        data-open={open ? "true" : "false"}
        aria-label={label}
        style={{ "--cb-ld-list": `${listMin}px` } as CSSProperties}
      >
        <div
          ref={listPane}
          className="cb-listdetail-list"
          data-part="list-pane"
          hidden={hiddenList}
          onScroll={(e) => {
            if (!hiddenList) scrolled.current = e.currentTarget.scrollTop;
          }}
        >
          {list}
        </div>
        {pane !== null ? (
          <div className="cb-listdetail-detail" data-part="detail-pane">
            {wide ? null : (
              <div className="cb-listdetail-bar" data-part="back-bar">
                <IconButton
                  label={t("shell.back")}
                  icon={<Icon name="chevron-left" />}
                  density="default"
                  onClick={onBack}
                />
              </div>
            )}
            <div className="cb-listdetail-body">{pane}</div>
          </div>
        ) : null}
      </section>
    </ModeContext.Provider>
  );
}
