import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef } from "react";
import { IconButton } from "../controls/index";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { useViewportSegments } from "../shell/segments";
import { useRegisterShellPage } from "../shell/shell-page";

export type ListDetailProps = {
  /** The list: the page itself in the stack form. */
  list: ReactNode;
  /** The open item; `null` = nothing open (the stack shows the list). */
  detail: ReactNode | null;
  /**
   * Closes the open item: the stack's own back bar calls it, and inside an `AppShell` the shell's
   * top bar does (the item is a pushed page there, spec §4.6).
   */
  onBack(): void;
  /** The list column's width and the detail's least width: both panes need `listMin + detailMin`. */
  listMin: number;
  detailMin: number;
  /** The region's name (an accessible name for the group). */
  label: string;
  /** What two panes show while `detail` is `null` (the template's default item, or a hint). */
  preview?: ReactNode;
  /** A row under both panes in two panes, under the open item in the stack (the decision row). */
  footer?: ReactNode;
  /** A `line-soft` divider `space.4` from each pane (the form card's list + editor, spec §5.8). */
  divided?: boolean;
  /** Set by `Grid columns="list-detail"`: the region keeps the grid's `data-columns` marker. */
  columns?: "list-detail";
};

/**
 * The fits the stylesheet knows (`listMin + detailMin`): a container query cannot take a value
 * from a prop, so each consumer's threshold has its own rules in `templates.css`.
 */
export const LIST_DETAIL_FITS = [580, 680] as const;

/**
 * The one behavior of a list-detail region (spec §6.47): two panes while the region's own width
 * (a container query on the region, so the sidebar, a rail and a second viewport segment count)
 * fits `listMin + detailMin`, else the two-level stack: the list is the page, an item is pushed in
 * its place with a back button, and back returns to the list at its scroll position. Both forms
 * are always drawn and CSS picks one, so the server render is right at every width.
 */
export function ListDetail({
  list,
  detail,
  onBack,
  listMin,
  detailMin,
  label,
  preview,
  footer,
  divided,
  columns,
}: ListDetailProps) {
  const t = useDesignT();
  const fit = listMin + detailMin;
  if (!(LIST_DETAIL_FITS as readonly number[]).includes(fit)) {
    throw new Error(`ListDetail: no stylesheet rules for the fit ${fit} (LIST_DETAIL_FITS)`);
  }
  const segments = useViewportSegments();
  const open = detail !== null;
  const listPane = useRef<HTMLDivElement>(null);
  const scrolled = useRef(0);

  // Inside an AppShell an open item is a pushed page: the top bar's back closes it.
  const back = useRef(onBack);
  back.current = onBack;
  const shellBack = useCallback(() => back.current(), []);
  // Side by side on two segments the item is no pushed page: no shell back.
  useRegisterShellPage(open && !segments ? { onBack: shellBack } : {});

  // The list keeps its scroll position while an item covers it (it is display: none then).
  useEffect(() => {
    if (!open && listPane.current) listPane.current.scrollTop = scrolled.current;
  }, [open]);

  return (
    <div className="cb-ld" data-part="list-detail-frame">
      <section
        className="cb-listdetail"
        data-part="list-detail"
        data-fit={fit}
        data-open={open ? "true" : "false"}
        data-segments={segments ? "2" : undefined}
        data-divided={divided ? "true" : undefined}
        data-columns={columns}
        aria-label={label}
        style={{ "--cb-ld-list": `${listMin}px` } as CSSProperties}
      >
        <div
          ref={listPane}
          className="cb-listdetail-list"
          data-part="list-pane"
          onScroll={(e) => {
            if (!open) scrolled.current = e.currentTarget.scrollTop;
          }}
        >
          {list}
        </div>
        <div className="cb-listdetail-detail" data-part="detail-pane">
          <div className="cb-listdetail-bar" data-part="back-bar">
            <IconButton
              label={t("shell.back")}
              icon={<Icon name="chevron-left" />}
              density="default"
              onClick={onBack}
            />
          </div>
          <div className="cb-listdetail-body">{detail ?? preview ?? null}</div>
        </div>
        {footer ? (
          <div className="cb-listdetail-footer" data-part="list-detail-footer">
            {footer}
          </div>
        ) : null}
      </section>
    </div>
  );
}
