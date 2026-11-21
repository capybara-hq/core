import * as RD from "@radix-ui/react-dialog";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../icons/icon";
import { useDragDismiss } from "./drag";
import { useFocusReturn } from "./focus-return";
import { useOverlayHistory } from "./use-overlay-history";

export type DrawerProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The accessible name of the dialog (the drawer draws no title of its own). */
  label: string;
  children: ReactNode;
};

const FIRST_ROW = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * The chat-first shell's drawer (design spec §6.52): a panel from the start edge over a scrim,
 * `layout.drawer` wide. Opening moves focus to its first row; Escape, the scrim, a pick (a link or
 * a row marked `data-drawer-pick`) and a drag toward the start edge past 40 % close it and focus
 * returns to the trigger. While closed it draws nothing, so no edge listens for a swipe (the menu
 * button is the way in). On a compact touch window the system back closes it (`useOverlayHistory`).
 */
export function Drawer({ open, onOpenChange, label, children }: DrawerProps) {
  const focusReturn = useFocusReturn();
  const panel = useRef<HTMLDivElement | null>(null);
  const history = useOverlayHistory(open, () => onOpenChange(false));
  const drag = useDragDismiss({
    axis: "x",
    size: () => panel.current?.offsetWidth ?? 0,
    onDismiss: () => onOpenChange(false),
    direction: -1,
  });
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="cb-drawer-scrim" data-part="drawer-scrim" {...drag.scrimProps} />
        <RD.Content
          ref={panel}
          className="cb-drawer"
          data-part="drawer"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-describedby={undefined}
          {...drag.handleProps}
          {...drag.panelProps}
          onOpenAutoFocus={(e) => {
            focusReturn.capture();
            e.preventDefault();
            panel.current?.querySelector<HTMLElement>(FIRST_ROW)?.focus();
          }}
          onCloseAutoFocus={focusReturn.restore}
          onClick={(e: MouseEvent<HTMLElement>) => {
            // a link anywhere in the panel (a recent conversation) is a pick too
            if ((e.target as HTMLElement).closest("[data-drawer-pick], a[href]")) {
              history.leaveEntry();
              onOpenChange(false);
            }
          }}
        >
          <RD.Title className="cb-sr-only">{label}</RD.Title>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export type DrawerLevelProps = {
  title: string;
  backLabel: string;
  onBack(): void;
  children: ReactNode;
};

/**
 * A deeper level of the drawer (design spec §6.52): replaces the list; its back row (an arrow, the
 * parent's name as `backLabel`) returns. The drawer stays open.
 */
export function DrawerLevel({ title, backLabel, onBack, children }: DrawerLevelProps) {
  const back = useRef<HTMLButtonElement | null>(null);
  // The row that opened the level (it unmounts with the list): read while rendering, before the
  // commit removes it, and found again by its label when the level goes.
  const [opener] = useState(() =>
    typeof document === "undefined" ? "" : (document.activeElement?.textContent ?? ""),
  );
  useEffect(() => {
    const button = back.current;
    const panel = button?.closest<HTMLElement>('[data-part="drawer"]') ?? null;
    button?.focus();
    return () => {
      queueMicrotask(() => {
        if (panel === null || !panel.isConnected) return;
        const rows = [...panel.querySelectorAll<HTMLElement>(FIRST_ROW)];
        (rows.find((r) => opener !== "" && r.textContent === opener) ?? rows[0])?.focus();
      });
    };
  }, [opener]);
  return (
    <div className="cb-drawer-level" data-part="drawer-level">
      <button
        ref={back}
        type="button"
        className="cb-navrow cb-drawer-back"
        data-part="drawer-back"
        aria-label={backLabel}
        onClick={onBack}
      >
        <Icon name="arrow-left" size={16} />
        <span className="cb-navrow-label">{title}</span>
      </button>
      <div className="cb-drawer-level-body">{children}</div>
    </div>
  );
}

export type DrawerFrameProps = {
  label: string;
  /** The page behind the drawer. */
  page?: ReactNode;
  children: ReactNode;
};

/**
 * A drawer drawn open without a dialog around it, filling its parent (a stage that clips it): the
 * reference blocks and `/dev/ui` use it. The real drawer is `Drawer`.
 */
export function DrawerFrame({ label, page, children }: DrawerFrameProps) {
  return (
    <div className="cb-drawer-stage" data-part="drawer-stage">
      <div className="cb-drawer-page">{page}</div>
      <div className="cb-drawer-scrim cb-drawer-static" data-part="drawer-scrim" />
      <div
        className="cb-drawer cb-drawer-static"
        data-part="drawer"
        role="dialog"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
