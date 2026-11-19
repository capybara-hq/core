import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef } from "react";
import { IconButton } from "../controls/index";
import { KeyValue } from "../display/key-value";
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

  // Stacked segments: the footer is part of the second segment, so its height comes off the
  // detail's row (CSS cannot ask a sibling for it).
  const hasFooter = Boolean(footer);
  const section = useRef<HTMLElement>(null);
  const footerEl = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasFooter re-runs it when the footer comes or goes (the ref itself does not)
  useEffect(() => {
    const host = section.current;
    const f = footerEl.current;
    if (!host || !f || !segments || typeof ResizeObserver === "undefined") return;
    const set = () => host.style.setProperty("--cb-ld-footer-h", `${f.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(f);
    return () => {
      ro.disconnect();
      host.style.removeProperty("--cb-ld-footer-h");
    };
  }, [segments, hasFooter]);

  // The list keeps its scroll position while an item covers it (it is display: none then).
  useEffect(() => {
    if (!open && listPane.current) listPane.current.scrollTop = scrolled.current;
  }, [open]);

  return (
    <div className="cb-ld" data-part="list-detail-frame">
      <section
        ref={section}
        className="cb-listdetail"
        data-part="list-detail"
        data-fit={fit}
        data-open={open ? "true" : "false"}
        data-segments={segments ? "2" : undefined}
        data-divided={divided ? "true" : undefined}
        data-columns={columns}
        aria-label={label}
        style={
          { "--cb-ld-list": `${listMin}px`, "--cb-ld-detail": `${detailMin}px` } as CSSProperties
        }
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
          <div ref={footerEl} className="cb-listdetail-footer" data-part="list-detail-footer">
            {footer}
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** One row of a list-detail region's list (spec §6.47). */
export type ListDetailListItem = {
  id: string;
  title: string;
  /** Beside the title and never cut (a version): the title takes the ellipsis. */
  trailing?: string;
  meta?: string;
  /** The time at the row's end (`micro`, `faint`). */
  at?: string;
  /** Waits for the person: the 6 px `warn` dot at the row's start. */
  waiting?: boolean;
};

/**
 * The list of a list-detail region (spec §6.47): 64 px rows split by `line-soft`, each a 6 px state
 * dot slot (filled only for what waits for the person), the title (`body`, `ink`) over the meta
 * (`small`, `muted`), both one line with an ellipsis, and the time at the end. The current row
 * (two panes) is the selected row of §2.3. A row is a button that opens its item.
 */
export function ListDetailList({
  label,
  items,
  current,
  onOpen,
}: {
  label: string;
  items: ListDetailListItem[];
  current?: string | undefined;
  onOpen(id: string): void;
}) {
  const t = useDesignT();
  return (
    <ul className="cb-ld-list" data-part="list" aria-label={label}>
      {items.map((it) => (
        <li key={it.id}>
          <button
            type="button"
            className="cb-ld-row"
            data-part="list-row"
            aria-current={it.id === current ? "true" : undefined}
            onClick={() => onOpen(it.id)}
          >
            {it.waiting ? (
              <span
                className="cb-ld-dot"
                data-part="list-dot"
                data-state="warn"
                role="img"
                aria-label={t("listDetail.waiting")}
              />
            ) : (
              <span className="cb-ld-dot" data-part="list-dot" aria-hidden="true" />
            )}
            <span className="cb-ld-text">
              <span className="cb-ld-head">
                <span className="cb-ld-title" data-part="list-title" title={it.title}>
                  {it.title}
                </span>
                {it.trailing ? (
                  <span className="cb-ld-trailing" data-part="list-trailing">
                    {it.trailing}
                  </span>
                ) : null}
              </span>
              {it.meta ? (
                <span className="cb-ld-meta" data-part="list-meta">
                  {it.meta}
                </span>
              ) : null}
            </span>
            {it.at ? (
              <span className="cb-ld-time" data-part="list-time">
                {it.at}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One fact of an open item: a translated label, never a raw payload key (spec §6.47). */
export type ListDetailFact = { label: string; value: ReactNode; mono?: boolean };

/**
 * The open item of a list-detail region (spec §6.47, §5.7), a page body padded `space.4` that
 * scrolls: its title (`h2`, with an optional `status` mark beside it), its facts (a KeyValue
 * `facts` variant of translated labels; a tool key's value stays mono; `aside` adds what belongs
 * with them, such as a link) and the page's content (`children`), with `actions` (the decision
 * ActionRow) pinned at the bottom of the pane. The facts come before the content; from a 1100
 * region (expanded) they are a 400 column beside it.
 */
export function ListDetailItem({
  title,
  status,
  facts = [],
  factsLabel,
  aside,
  actions,
  children,
}: {
  title?: string | undefined;
  status?: ReactNode;
  facts?: ListDetailFact[];
  /** The facts block's accessible name. */
  factsLabel?: string | undefined;
  aside?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const hasFacts = facts.length > 0 || (aside !== undefined && aside !== null);
  const hasContent = children !== undefined && children !== null && children !== false;
  return (
    <div className="cb-ld-item" data-part="list-detail-item">
      <div
        className="cb-ld-item-body"
        data-part="list-detail-body"
        data-facts={hasFacts && hasContent ? "true" : undefined}
      >
        {title !== undefined || status ? (
          <div className="cb-ld-item-head" data-part="list-detail-head">
            {title !== undefined ? <h2 className="cb-ld-item-title">{title}</h2> : null}
            {status}
          </div>
        ) : null}
        {hasFacts ? (
          <aside
            className="cb-ld-item-facts"
            data-part="list-detail-facts"
            {...(factsLabel !== undefined ? { "aria-label": factsLabel } : {})}
          >
            {facts.length > 0 ? (
              <KeyValue
                variant="facts"
                rows={facts.map((f) => ({
                  k: f.label,
                  v: f.value,
                  ...(f.mono ? { mono: true } : {}),
                }))}
              />
            ) : null}
            {aside}
          </aside>
        ) : null}
        {hasContent ? (
          <div className="cb-ld-item-content" data-part="list-detail-content">
            {children}
          </div>
        ) : null}
      </div>
      {actions}
    </div>
  );
}
