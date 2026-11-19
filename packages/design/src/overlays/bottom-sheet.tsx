import * as RD from "@radix-ui/react-dialog";
import { type ReactNode, type Ref, useId, useRef } from "react";
import { IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { type DragState, useDragDismiss } from "./drag";
import { useFocusReturn } from "./focus-return";

// The bottom sheet (spec §6.7 "Follow-finger sheets"; mobile layout spec §7.4): a grab handle over
// a head with the title and a 40 px close button, then the body, over a scrim. The handle and the
// head drag it down; the body drags it only while its own scroll is at the top.

type InnerProps = {
  /** The title element: a Radix `Title` inside a dialog, a plain heading in a static block. */
  title: ReactNode;
  /** The close button (a Radix `Close` inside a dialog). */
  close: ReactNode;
  /** The accessible name of the grab handle; without it the handle is decorative. */
  handleLabel?: string | undefined;
  bodyRef?: Ref<HTMLDivElement>;
  children?: ReactNode;
};

/** The handle, the head and the body: the inside of every bottom sheet. */
function BottomSheetInner({ title, close, handleLabel, bodyRef, children }: InnerProps) {
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
        {title}
        <span className="cb-grow" />
        {close}
      </header>
      <div className="cb-bsheet-body" data-part="bsheet-body" ref={bodyRef}>
        {children}
      </div>
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
  /** The page behind the sheet. */
  page?: ReactNode;
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
  page,
  children,
}: BottomSheetFrameProps) {
  const t = useDesignT();
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
        data-state={state}
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
            />
          }
          handleLabel={handleLabel}
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
  children,
}: BottomSheetContentProps) {
  const t = useDesignT();
  const focusReturn = useFocusReturn();
  const sheet = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const drag = useDragDismiss({
    axis: "y",
    size: () => sheet.current?.offsetHeight ?? 0,
    scroller: body,
    onDismiss,
  });
  return (
    <RD.Portal>
      <RD.Overlay className="cb-bsheet-scrim" data-part="bsheet-scrim" {...drag.scrimProps} />
      <RD.Content
        ref={sheet}
        className="cb-bsheet"
        data-part={part}
        aria-describedby={undefined}
        onOpenAutoFocus={focusReturn.capture}
        onCloseAutoFocus={focusReturn.restore}
        {...drag.handleProps}
        {...drag.panelProps}
      >
        <BottomSheetInner
          title={<RD.Title className="cb-bsheet-title">{title}</RD.Title>}
          close={
            <RD.Close asChild>
              <IconButton label={t("overlay.close")} icon={<Icon name="x" size={16} />} />
            </RD.Close>
          }
          handleLabel={handleLabel}
          bodyRef={body}
        >
          {children}
        </BottomSheetInner>
      </RD.Content>
    </RD.Portal>
  );
}

export type BottomSheetProps = Omit<BottomSheetContentProps, "onDismiss"> & {
  open: boolean;
  onOpenChange(open: boolean): void;
};

/** A controlled bottom sheet (a Filter sheet, the Me page's org and language sheets). */
export function BottomSheet({ open, onOpenChange, ...content }: BottomSheetProps) {
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
  checked?: boolean;
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
        >
          <input
            type="radio"
            className="cb-sr-only"
            name={name}
            value={o.id}
            checked={o.checked === true}
            onChange={() => onPick?.(o.id)}
          />
          <span className="cb-sheet-option-check">
            {o.checked ? <Icon name="check" size={14} /> : null}
          </span>
          <span className="cb-sheet-option-label">{o.label}</span>
          {o.count !== undefined ? <span className="cb-sheet-option-count">{o.count}</span> : null}
        </label>
      ))}
    </div>
  );
}
