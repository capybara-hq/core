import * as RD from "@radix-ui/react-dialog";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/button";
import { Badge } from "../display/basic";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { type DragState, useDragDismiss } from "./drag";
import { useFocusReturn } from "./focus-return";
import { FIRST_FOCUSABLE, focusOnOpen } from "./quiet-focus";
import { useOverlayHistory } from "./use-overlay-history";

// The bottom sheet (spec §6.59 "Bottom sheet"; mobile layout spec §7.4): a grab handle over a head
// with the centred title and a round close button, then the body, over a scrim. The handle and the
// head drag it down; the body drags it only while its own scroll is at the top. The body's parts
// (SheetGroup, SheetRow, SheetFootnote) are shared by every bottom sheet, so no sheet styles its own.

type InnerProps = {
  /** The title element: a Radix `Title` inside a dialog, a plain heading in a static block. */
  title: ReactNode;
  /** The close button (a Radix `Close` inside a dialog). */
  close: ReactNode;
  /** A drill-in page's back control, at the head's start (§6.59 "In-sheet drill-in"). */
  back?: ReactNode;
  /** The accessible name of the grab handle; without it the handle is decorative. */
  handleLabel?: string | undefined;
  bodyRef?: Ref<HTMLDivElement>;
  /** Drawn under the body, outside its scroll (a dialog's buttons). */
  footer?: ReactNode;
  children?: ReactNode;
};

/** The handle, the head and the body: the inside of every bottom sheet. */
function BottomSheetInner({
  title,
  close,
  back,
  handleLabel,
  bodyRef,
  footer,
  children,
}: InnerProps) {
  return (
    <>
      <div className="cb-bsheet-grab" data-part="handle-zone">
        <span
          className="cb-bsheet-handle"
          data-part="sheet-handle"
          {...(handleLabel ? { role: "img", "aria-label": handleLabel } : { "aria-hidden": true })}
        />
      </div>
      <header className="cb-bsheet-head" data-part="sheet-head">
        {back}
        {title}
        {close}
      </header>
      <div className="cb-bsheet-body" data-part="bsheet-body" ref={bodyRef}>
        {children}
      </div>
      {footer !== undefined ? (
        <div className="cb-bsheet-foot" data-part="bsheet-foot">
          {footer}
        </div>
      ) : null}
    </>
  );
}

export type BottomSheetFrameProps = {
  title: string;
  /** The drag state to draw (the reference blocks draw `dragging` and `settling`). */
  state: DragState;
  /** The share of the sheet's height dragged down, 0 to 1: it sets the offset. */
  share: number;
  handleLabel?: string | undefined;
  closeLabel?: string | undefined;
  /** A drilled-in page's back control (named by this label), as the real sheet draws it. */
  backLabel?: string | undefined;
  /** The page behind the sheet. */
  page?: ReactNode;
  /** Drawn under the body, outside its scroll (a dialog's buttons). */
  footer?: ReactNode;
  children?: ReactNode;
};

/**
 * A bottom sheet drawn in a fixed drag state, without a dialog around it, filling its parent
 * (a stage that clips it): the reference blocks and `/dev/ui` use it. The real sheet is
 * `BottomSheet`.
 */
export function BottomSheetFrame({
  title,
  state,
  share,
  handleLabel,
  closeLabel,
  backLabel,
  page,
  footer,
  children,
}: BottomSheetFrameProps) {
  const t = useDesignT();
  const grab = handleLabel ?? t("overlay.dragToClose");
  return (
    <div className="cb-bsheet-stage" data-part="sheet-stage">
      <div className="cb-bsheet-page">{page}</div>
      <div
        className="cb-bsheet-scrim cb-bsheet-static"
        data-part="scrim"
        data-drag={state}
        style={{ opacity: 1 - share }}
      />
      <div
        className="cb-bsheet cb-bsheet-static"
        data-part="sheet"
        data-drag={state}
        role="dialog"
        aria-label={title}
        style={{ transform: `translateY(${share * 100}%)` }}
      >
        <BottomSheetInner
          title={<h2 className="cb-bsheet-title">{title}</h2>}
          close={
            <IconButton
              label={closeLabel ?? t("overlay.close")}
              icon={<Icon name="x" size={16} />}
              className="cb-bsheet-close"
              part="sheet-close"
            />
          }
          {...(backLabel
            ? {
                back: (
                  <IconButton
                    label={backLabel}
                    icon={<Icon name="chevron-left" size={16} />}
                    className="cb-bsheet-back"
                    part="sheet-back"
                  />
                ),
              }
            : {})}
          handleLabel={grab}
          footer={footer}
        >
          {children}
        </BottomSheetInner>
      </div>
    </div>
  );
}

export type BottomSheetContentProps = {
  title: string;
  /** Called when a drag dismissed the sheet (close it: set the dialog's `open` to false). */
  onDismiss(): void;
  /** The sheet's `data-part` (the default "sheet"). */
  part?: string;
  handleLabel?: string | undefined;
  /** The id of the element that describes the sheet (its `aria-describedby`). */
  describedBy?: string | undefined;
  /**
   * Where focus starts on open (a dialog drawn as a sheet keeps its own start, §6.7); by default,
   * or when it returns nothing, the first control (the close).
   */
  initialFocus?: ((sheet: HTMLElement) => HTMLElement | null | undefined) | undefined;
  /** Drawn under the body, outside its scroll, over the bottom inset (a dialog's buttons). */
  footer?: ReactNode;
  /**
   * In-sheet drill-in (§6.59): the key of the page the body shows. A change slides the new page
   * in (from the end edge when it has `back`, a push; from the start without, a pop; none under
   * reduced motion) and scrolls the body to its top. The caller moves the focus.
   */
  page?: string;
  /**
   * A drilled-in page's way back (§6.59): a back control at the head's start named `label`; Esc
   * goes back too instead of closing. The `title` is then the page's.
   */
  back?: { label: string; onBack(): void } | undefined;
  /**
   * Whether focus goes back to where it was when the sheet opened, decided as it closes (default
   * true). The composer menu's sheet passes `() => !isTouchPointer()`: on touch a choice never
   * focuses the composer, whose focus would pop the keyboard.
   */
  returnFocus?: boolean | (() => boolean);
  children?: ReactNode;
};

/**
 * The scrim and the follow-finger sheet of a dialog: put it inside a Radix `Dialog.Root` (the
 * composer's options sheet has its own trigger). Esc, the scrim and the close button close it as
 * for any overlay and focus returns (§6.11).
 */
export function BottomSheetContent({
  title,
  onDismiss,
  part = "sheet",
  handleLabel,
  describedBy,
  initialFocus,
  footer,
  page,
  back,
  returnFocus = true,
  children,
}: BottomSheetContentProps) {
  const t = useDesignT();
  // The page shown and how it came (a push or a pop): adjusted while rendering, so the new page's
  // first paint already slides; the first page never does.
  const [shown, setShown] = useState<{ page: string | undefined; nav?: "push" | "pop" }>({
    page,
  });
  if (shown.page !== page) setShown({ page, nav: back ? "push" : "pop" });
  const focusReturn = useFocusReturn();
  const sheet = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // The portal mounts the body after this component's first render: a state change on mount
  // re-renders it so the drag hook attaches its touch listeners to the body.
  const [, setBodyMounted] = useState(false);
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    body.current = el;
    setBodyMounted(el !== null);
  }, []);
  const drag = useDragDismiss({
    axis: "y",
    size: () => sheet.current?.offsetHeight ?? 0,
    scroller: body,
    onDismiss,
  });
  // a new page starts at its top
  useLayoutEffect(() => {
    if (page !== undefined && body.current) body.current.scrollTop = 0;
  }, [page]);
  return (
    <RD.Portal>
      <RD.Overlay className="cb-bsheet-scrim" data-part="bsheet-scrim" {...drag.scrimProps} />
      <RD.Content
        ref={sheet}
        className="cb-bsheet"
        data-part={part}
        aria-describedby={describedBy}
        onOpenAutoFocus={(e) => {
          focusReturn.capture();
          // the caller's start, else the first control (the close button), ringed only when
          // opened from the keyboard (§2.5)
          e.preventDefault();
          const el = sheet.current;
          focusOnOpen(
            (el ? initialFocus?.(el) : undefined) ??
              el?.querySelector<HTMLElement>(FIRST_FOCUSABLE),
          );
        }}
        onCloseAutoFocus={(e) => {
          if (typeof returnFocus === "function" ? returnFocus() : returnFocus) {
            focusReturn.restore(e);
            return;
          }
          // no return at all, not even Radix's own to the element focused before
          e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          // a drilled-in page: Esc goes back a page, the next one closes the sheet
          if (!back) return;
          e.preventDefault();
          back.onBack();
        }}
        {...drag.handleProps}
        {...drag.panelProps}
      >
        <BottomSheetInner
          title={<RD.Title className="cb-bsheet-title">{title}</RD.Title>}
          close={
            <RD.Close asChild>
              <IconButton
                label={t("overlay.close")}
                icon={<Icon name="x" size={16} />}
                className="cb-bsheet-close"
                part="sheet-close"
              />
            </RD.Close>
          }
          {...(back
            ? {
                back: (
                  <IconButton
                    label={back.label}
                    icon={<Icon name="chevron-left" size={16} />}
                    className="cb-bsheet-back"
                    part="sheet-back"
                    onClick={back.onBack}
                  />
                ),
              }
            : {})}
          handleLabel={handleLabel ?? t("overlay.dragToClose")}
          bodyRef={bodyRef}
          footer={footer}
        >
          {page === undefined ? (
            children
          ) : (
            <div
              key={page}
              className="cb-bsheet-pane"
              data-part="sheet-pane"
              data-page={page}
              data-nav={shown.page === page ? shown.nav : undefined}
            >
              {children}
            </div>
          )}
        </BottomSheetInner>
      </RD.Content>
    </RD.Portal>
  );
}

export type BottomSheetProps = Omit<BottomSheetContentProps, "onDismiss"> & {
  open: boolean;
  onOpenChange(open: boolean): void;
};

/** A controlled bottom sheet (a Filter sheet, the account sheet). */
export function BottomSheet({ open, onOpenChange, ...content }: BottomSheetProps) {
  // Back closes an open sheet first on a compact touch window (mobile app plan Decision 25).
  useOverlayHistory(open, () => onOpenChange(false));
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent {...content} onDismiss={() => onOpenChange(false)} />
    </RD.Root>
  );
}

export type SheetOption = {
  id: string;
  label: string;
  /** A count after the label (a filter's matches). */
  count?: number;
  /** A muted tag after the label (a model's agent-default tag, a disabled one's reason). */
  tag?: string;
  /** An attention mark after the tag, as a Badge (`warn` unless `badgeTone`). */
  badge?: string;
  badgeTone?: "default" | "warn" | "fail";
  checked?: boolean;
  /** Not choosable now (an org switch in flight). */
  disabled?: boolean;
};

/**
 * Single-choice options in a sheet's body (a Filter sheet): radios, each `40` high with a check
 * slot, the label and an optional muted count; the checked one on the `selected` ground.
 */
export function SheetOptionList({
  label,
  options,
  onPick,
}: {
  label: string;
  options: SheetOption[];
  onPick?: (id: string) => void;
}) {
  const name = useId();
  return (
    <div className="cb-sheet-options" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label
          key={o.id}
          className="cb-sheet-option"
          data-part="option"
          data-checked={o.checked ? "true" : undefined}
          data-disabled={o.disabled ? "true" : undefined}
        >
          <input
            type="radio"
            className="cb-sr-only"
            name={name}
            value={o.id}
            checked={o.checked === true}
            disabled={o.disabled === true}
            onChange={() => onPick?.(o.id)}
            // a native radio fires no change when already checked: tapping it still picks
            onClick={() => {
              if (o.checked) onPick?.(o.id);
            }}
          />
          <span className="cb-sheet-option-check">
            {o.checked ? <Icon name="check" size={14} /> : null}
          </span>
          <span className="cb-sheet-option-label">{o.label}</span>
          {o.tag ? (
            <span className="cb-cmenu-tag" data-part="option-tag">
              {o.tag}
            </span>
          ) : null}
          {o.badge ? <Badge tone={o.badgeTone ?? "warn"}>{o.badge}</Badge> : null}
          {o.count !== undefined ? <span className="cb-sheet-option-count">{o.count}</span> : null}
        </label>
      ))}
    </div>
  );
}
